import { financialCalendarWindow, financialLocalDay } from '../../../shared/financials/day-window.js';
import { midgardActionTimestampSeconds } from '../../../shared/dynamic-fees/affiliate-volume.js';
import { financialSwapLedgerCovers, financialSwapRow, financialSwapSettlement, readFinancialSwapLedgerDay,
  readFinancialSwapLedgerStart, priceFinancialSwapRows, priceFinancialSwapRowsAtPrices } from './financials-swap-candidates.js';

const DAY = 86400;
export const FINANCIAL_DAY_REFRESH_MS = 15 * 60_000;
export const FINANCIAL_DAY_VISITOR_LEASE_MS = 2 * 60_000;
export const FINANCIAL_DAY_ROSTER_HORIZON_SECONDS = 900;
export const FINANCIAL_DAY_ROSTER_SOURCE_LAG_SECONDS = 180;
const MAX_EXCLUSION_IDS = 512;
const SETTLEMENT_BACKOFF_MS = [3600_000, 6 * 3600_000, 24 * 3600_000];
const iso = seconds => new Date(seconds * 1000).toISOString();
const positive = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const integer = value => /^\d+$/.test(String(value ?? ''));

export const financialDetailDay = financialCalendarWindow;

/** Let the quarter-hour Pool Analysis capture finish before using its exact
 * saved prefix. Follow wall-clock boundaries rather than drifting by however
 * long the previous action scan took. Visitor-only historical work is unchanged. */
export function financialDayRefreshAt(now = Date.now(), { background = false } = {}) {
  if (!background) return now + FINANCIAL_DAY_REFRESH_MS;
  const interval = FINANCIAL_DAY_ROSTER_HORIZON_SECONDS * 1000;
  const grace = FINANCIAL_DAY_ROSTER_SOURCE_LAG_SECONDS * 1000;
  return (Math.floor((now - grace) / interval) + 1) * interval + grace;
}

export function financialDayRosterReadyAt(day, now = Date.now(), timeZone = 'UTC') {
  return Math.max(now, (financialDetailDay(day, now, timeZone).from
    + FINANCIAL_DAY_ROSTER_HORIZON_SECONDS + FINANCIAL_DAY_ROSTER_SOURCE_LAG_SECONDS) * 1000);
}

async function rankedSwaps(actions, from, through, priceSwaps) {
  const rows = [];
  const exclusions = [];
  for (const action of actions) {
    const seconds = midgardActionTimestampSeconds(action.date);
    if (seconds < from || seconds >= through || action.type !== 'swap') continue;
    const { row, exclusion } = financialSwapRow(action);
    if (row) rows.push(row); else exclusions.push(exclusion);
  }
  const priced = await priceSwaps(rows);
  return { rows: priced.filter(row => Number.isFinite(row.feeUsd) && row.feeUsd >= 0),
    exclusions: [...exclusions, ...priced.filter(row => !Number.isFinite(row.feeUsd) || row.feeUsd < 0)
      .map(row => ({ txId: row.txId, kind: 'unpriced' }))] };
}

function mergeRankedSwaps(state, ranked) {
  const exclusions = new Map((state.exclusions || []).map(row => [row.txId, row]));
  const successful = new Set([...state.swaps, ...ranked.rows].map(row => row.txId));
  const removeExclusion = txId => {
    const previous = exclusions.get(txId);
    if (!previous) return;
    state[previous.kind] = Math.max(0, state[previous.kind] - 1);
    exclusions.delete(txId);
  };
  for (const row of ranked.rows) removeExclusion(row.txId);
  for (const row of ranked.exclusions) {
    if (row.txId) removeExclusion(row.txId);
    // Pages may repeat an older pending/unpriced view of a settled action.
    // Known success wins over that stale duplicate, including across deltas.
    if (successful.has(row.txId)) continue;
    state[row.kind]++;
    if (row.txId && exclusions.size < MAX_EXCLUSION_IDS) exclusions.set(row.txId, row);
    else state.exclusionsIncomplete = true;
  }
  state.exclusions = [...exclusions.values()];
  state.swaps = topSwaps([...state.swaps, ...ranked.rows]);
}

/** Acquisition completion is independent of pending/unpriced financial finality. */
export function financialDaySnapshotComplete(day, payload) {
  return Boolean(payload && Date.parse(payload.through) >= payloadWindowEnd(day, payload));
}

function payloadWindowEnd(day, payload) {
  return payload?.windowTo ? Date.parse(payload.windowTo)
    : financialDetailDay(day, Number.MAX_SAFE_INTEGER, payload?.timeZone || 'UTC').to * 1000;
}

function pendingIds(exclusions) {
  return [...new Set((Array.isArray(exclusions) ? exclusions : [])
    .filter(row => row?.kind === 'pending' && typeof row.txId === 'string' && row.txId.trim())
    .map(row => row.txId.trim().toUpperCase()))].slice(0, MAX_EXCLUSION_IDS);
}

const settlementPassCount = value => Number.isFinite(Number(value)) && Number(value) >= 0
  ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value))) : 0;

/** Settlement is separate from coverage: closed days only revisit retained IDs,
 * never the day-wide actions cursor or already acquired pool totals. */
export function financialDaySettlement(day, payload) {
  if (!financialDaySnapshotComplete(day, payload)) return null;
  const remaining = Math.max(0, Number(payload.pendingSwaps) || 0);
  const actionable = pendingIds(payload.excludedSwaps).length > 0;
  const status = actionable ? 'pending' : remaining || payload.exclusionsIncomplete ? 'unavailable' : 'complete';
  return { status, checkedAt: payload.settlement?.checkedAt || null,
    nextCheckAt: actionable ? payload.settlement?.nextCheckAt || null : null, remaining,
    passCount: settlementPassCount(payload.settlement?.passCount ?? payload.settlement?.passes) };
}

export function financialDayNeedsWork(day, payload, now = Date.now()) {
  if (!financialDaySnapshotComplete(day, payload)) return true;
  const settlement = financialDaySettlement(day, payload);
  return settlement.status === 'pending' && !(Date.parse(settlement.nextCheckAt) > now);
}

export function financialDayNextWorkAt(day, payload, now = Date.now(), options = {}) {
  if (!payload) return now;
  if (!financialDaySnapshotComplete(day, payload)) return financialDayRefreshAt(now, options);
  const settlement = financialDaySettlement(day, payload);
  return settlement.status === 'pending' ? Math.max(now, Date.parse(settlement.nextCheckAt) || now) : null;
}

export function financialDaySnapshotFinalized(day, payload, now = Date.now()) {
  return financialDaySnapshotComplete(day, payload) && !payload.unpricedSwaps && !payload.pendingSwaps
    && !payload.exclusionsIncomplete && now >= payloadWindowEnd(day, payload) + 2 * DAY * 1000;
}

export function financialDayStateFromSnapshot(day, payload, now = Date.now()) {
  if (!payload) return null;
  return { ...financialDetailDay(day, now, payload.timeZone || 'UTC'), timeZone: payload.timeZone || 'UTC', runePrices: payload.runePrices || [], through: Date.parse(payload.through) / 1000,
    phase: 'done', swaps: payload.swaps || [], pools: (payload.pools || []).map(row => row.asset),
    poolRows: payload.pools || [], pages: 0, tokens: [], unpriced: payload.unpricedSwaps || 0,
    pending: payload.pendingSwaps || 0, exclusions: payload.excludedSwaps || [],
    exclusionsIncomplete: payload.exclusionsIncomplete ?? Boolean((payload.unpricedSwaps || payload.pendingSwaps) && !payload.excludedSwaps),
    settlement: payload.settlement ? { checkedAt: payload.settlement.checkedAt, nextCheckAt: payload.settlement.nextCheckAt,
      passes: settlementPassCount(payload.settlement.passCount) } : undefined,
    observedAt: payload.observedAt };
}

export function financialDayRetryAt(error, now = Date.now()) {
  const providerRetry = Date.parse(error?.retryAt || error?.blockedUntil || '');
  const retrySeconds = Math.max(0, Number(error?.retryAfterSeconds) || 0);
  return Math.max(now + (providerRetry > now || retrySeconds ? 1000 : 60_000), Number.isFinite(providerRetry) ? providerRetry : 0,
    now + retrySeconds * 1000);
}

function dayPayload(day, state, now) {
  const payload = {
    day, timeZone: state.timeZone || 'UTC', windowFrom: iso(state.from), windowTo: iso(state.to),
    runePrices: state.runePrices || [], through: iso(state.through), observedAt: state.observedAt || new Date(now).toISOString(),
    partial: state.through < state.to, unpricedSwaps: state.unpriced, pendingSwaps: state.pending,
    excludedSwaps: state.exclusions || [], exclusionsIncomplete: Boolean(state.exclusionsIncomplete),
    finalized: state.through === state.to && !state.unpriced && !state.pending && !state.exclusionsIncomplete && now / 1000 >= state.to + 2 * DAY,
    swaps: state.swaps, pools: topPools(state.poolRows),
    swapRankingBasis: 'liquidity-fees-usd', swapSource: 'midgard-actions', swapVolumeBasis: 'input-notional-usd', poolVolumeBasis: 'executed-leg-usd', source: 'liquify-midgard'
  };
  payload.settlement = financialDaySettlement(day, { ...payload, settlement: state.settlement });
  return payload;
}

async function advanceSettlement(day, state, getJson, now, priceSwaps) {
  const ids = pendingIds(state.exclusions);
  if (!ids.length || Date.parse(state.settlement?.nextCheckAt) > now) return { state, payload: dayPayload(day, state, now) };
  const pass = state.settlement ||= {};
  if (!Array.isArray(pass.ids) || pass.cursor >= pass.ids.length) {
    pass.ids = ids;
    pass.cursor = 0;
    pass.nextCheckAt = null;
  }
  const txId = pass.ids[pass.cursor];
  const response = await getJson(`/actions?${new URLSearchParams({ txid: txId, limit: '50' })}`);
  if (!Array.isArray(response?.actions)) throw new Error('Invalid pending swap lookup');
  const { action } = financialSwapSettlement(response.actions, txId);
  if (action) {
    const previous = (state.exclusions || []).find(row => row.kind === 'pending' && String(row.txId).trim().toUpperCase() === txId);
    if (previous) {
      state.exclusions = state.exclusions.filter(row => row !== previous);
      state.pending = Math.max(0, state.pending - 1);
      // Source action dates can move on settlement. Remove the stale pending
      // exclusion, but rank only an action whose updated date belongs here.
      if (action.type === 'swap') mergeRankedSwaps(state, await rankedSwaps([action], state.from, state.through, priceSwaps));
    }
  }
  pass.cursor++;
  if (pass.cursor >= pass.ids.length) {
    pass.passes = Math.min(Number.MAX_SAFE_INTEGER, settlementPassCount(pass.passes) + 1);
    pass.checkedAt = new Date(now).toISOString();
    pass.nextCheckAt = pendingIds(state.exclusions).length
      ? new Date(now + SETTLEMENT_BACKOFF_MS[Math.min(pass.passes - 1, SETTLEMENT_BACKOFF_MS.length - 1)]).toISOString() : null;
    delete pass.ids;
    delete pass.cursor;
  }
  return { state, payload: dayPayload(day, state, now) };
}

function topSwaps(rows) {
  return [...new Map(rows.map(row => [row.txId, row])).values()]
    .filter(row => Number.isFinite(row.feeUsd) && row.feeUsd >= 0)
    .sort((a, b) => b.feeUsd - a.feeUsd || a.txId.localeCompare(b.txId)).slice(0, 10);
}

const topPools = rows => rows.filter(row => row.volumeUsd > 0)
  .sort((a, b) => b.volumeUsd - a.volumeUsd || a.asset.localeCompare(b.asset)).slice(0, 10);

function poolsFromEarnings(payload, from, through) {
  const pools = new Set();
  const rows = payload?.intervals;
  if (!Array.isArray(rows)) throw new Error('Day earnings coverage unavailable');
  let cursor = from;
  for (const row of rows) {
    if (Number(row.startTime) < from || Number(row.startTime) >= through) continue;
    if (Number(row.startTime) !== cursor || Number(row.endTime) <= cursor || Number(row.endTime) > through || !Array.isArray(row.pools)) throw new Error('Day earnings coverage incomplete');
    cursor = Number(row.endTime);
    // Reward pseudo-pools have no chain.asset separator.
    for (const pool of row.pools) if (/^[A-Z0-9]+\./.test(pool.pool || '')) pools.add(pool.pool);
  }
  if (cursor !== through) throw new Error('Day earnings coverage incomplete');
  return [...pools].sort();
}

export function financialDetailHistoryQuery(from, through) {
  const daily = through - from === DAY && from % DAY === 0;
  return { interval: daily ? 'day' : '5min', from: String(from), count: String(daily ? 1 : (through - from) / 300) };
}

export function financialPoolVolume(payload, { from, through }, asset) {
  if (!Array.isArray(payload?.intervals)) throw new Error(`Pool history unavailable: ${asset}`);
  let cursor = from, usd = 0n, rune = 0n;
  for (const row of payload.intervals) {
    if (Number(row.startTime) < from || Number(row.startTime) >= through) continue;
    if (Number(row.startTime) !== cursor || Number(row.endTime) <= cursor || Number(row.endTime) > through
      || !integer(row.totalVolumeUSD) || !integer(row.totalVolume)) throw new Error(`Pool history incomplete: ${asset}`);
    cursor = Number(row.endTime);
    usd += BigInt(row.totalVolumeUSD); rune += BigInt(row.totalVolume);
  }
  if (cursor !== through) throw new Error(`Pool history incomplete: ${asset}`);
  return { asset, volumeUsd: Number(usd) / 100, volumeRune: Number(rune) / 1e8 };
}

/** Each call advances one provider request; persist before continuing. No
 * incomplete scan is published as a full-day top ten. A fixed source horizon
 * and opaque descending cursor survive both provider errors and restarts.
 * Days the swap stream ledger covers skip the actions scan entirely. */
export async function advanceFinancialDay(day, previous, getJson, now = Date.now(), options = {}) {
  const bounds = financialDetailDay(day, now, options.timeZone || previous?.timeZone || 'UTC');
  let state = previous ? structuredClone(previous) : { ...bounds, timeZone: bounds.timeZone || 'UTC', runePrices: [], phase: 'health', swaps: [], pools: [], poolRows: [], tokens: [], pages: 0, unpriced: 0, pending: 0 };
  state.timeZone ||= bounds.timeZone || 'UTC';
  const priceSwaps = rows => options.priceSwaps ? options.priceSwaps(rows, { from: state.from, to: state.to, prices: state.runePrices || [] })
    : priceFinancialSwapRowsAtPrices(rows, state.runePrices || []);
  if (state.phase === 'done') {
    if (state.through >= bounds.to) return advanceSettlement(day, state, getJson, now, priceSwaps);
    // A completed prefix needs only the next disjoint action interval. Retain
    // all known pool assets and unresolved IDs; the top ten of a union is the
    // top ten of its partitions' top tens. Pool totals are refreshed in full.
    state = { ...state, phase: 'health', actionFrom: state.through, poolRows: [],
      tokens: [], token: null, lastTimestamp: null, scanPages: 0, observedAt: null };
  }
  if (state.phase === 'health') {
    const health = await getJson('/health');
    const watermark = Number(health?.lastAggregated?.timestamp);
    if (health?.inSync !== true || !positive(watermark)) throw new Error('Midgard day-detail source is delayed');
    const horizon = options.background ? FINANCIAL_DAY_ROSTER_HORIZON_SECONDS : 300;
    const grace = options.background ? FINANCIAL_DAY_ROSTER_SOURCE_LAG_SECONDS : 0;
    state.through = Math.min(bounds.to, Math.floor(Math.min(watermark, now / 1000 - grace) / horizon) * horizon);
    if (state.through <= bounds.from) {
      const error = new Error(`Waiting for the first indexed ${options.background ? 'fifteen' : 'five'}-minute bucket`);
      if (options.background) error.retryAt = new Date(Math.max(financialDayRosterReadyAt(day, now, state.timeZone), financialDayRefreshAt(now, options))).toISOString();
      throw error;
    }
    if (state.actionFrom && state.through <= state.actionFrom) {
      // A delayed/unchanged watermark must neither regress the old snapshot
      // nor cause another pass over the same action pages.
      if (previous?.phase === 'done') return { state: structuredClone(previous), payload: dayPayload(day, previous, now) };
      throw new Error('Waiting for the next indexed five-minute bucket');
    }
    state.phase = 'earnings';
  } else if (state.phase === 'earnings') {
    const earningsFrom = state.actionFrom || state.from;
    const params = new URLSearchParams(financialDetailHistoryQuery(earningsFrom, state.through));
    const earnings = await getJson(`/history/earnings?${params}`);
    state.pools = [...new Set([...state.pools, ...poolsFromEarnings(earnings, earningsFrom, state.through)])].sort();
    state.runePrices = [...(state.runePrices || []), ...earnings.intervals.filter(row => positive(row.runePriceUSD))
      .map(row => ({ from: Number(row.startTime), to: Number(row.endTime), price: Number(row.runePriceUSD) }))];
    state.phase = options.streamSwaps ? 'pools' : 'actions';
  } else if (state.phase === 'actions') {
    // Midgard rejects timestamp + nextPageToken together. The first request
    // anchors the horizon; subsequent opaque cursors retain it, with local
    // interval checks on every returned action.
    const params = new URLSearchParams({ type: 'swap', limit: '50',
      ...(state.token ? { nextPageToken: state.token } : { timestamp: String(state.through) }) });
    const payload = await getJson(`/actions?${params}`);
    if (!Array.isArray(payload?.actions)) throw new Error('Invalid day swap page');
    let finished = payload.actions.length === 0;
    for (const action of payload.actions) {
      const timestamp = midgardActionTimestampSeconds(action.date);
      if (!(timestamp > 0)) throw new Error('Day swap is missing its timestamp');
      if (state.lastTimestamp && timestamp > state.lastTimestamp) throw new Error('Day swap pages are not descending');
      state.lastTimestamp = timestamp;
      if (timestamp < (state.actionFrom || state.from)) finished = true;
      if (timestamp >= (state.actionFrom || state.from) && timestamp < state.through) {
        for (const pool of action.pools || []) if (/^[A-Z0-9]+\./.test(pool) && !state.pools.includes(pool)) state.pools.push(pool);
      }
    }
    const ranked = await rankedSwaps(payload.actions, state.actionFrom || state.from, state.through, priceSwaps);
    mergeRankedSwaps(state, ranked);
    state.pages++; state.scanPages = (state.scanPages || 0) + 1;
    if (finished) state.phase = 'pools';
    else {
      const token = String(payload.meta?.nextPageToken || '');
      if (!token || state.tokens.includes(token)) throw new Error('Day swap pagination did not advance');
      if (state.scanPages > 10000) throw new Error('Day swap scan exceeded its safety limit');
      state.tokens.push(token); state.token = token;
    }
  } else if (state.phase === 'pools') {
    // Reuse exact cached prefixes before acquiring any missing local pool window.
    if (options.readPools && state.timeZone !== 'UTC') {
      const cached = await options.readPools(state.pools, { from: state.from, through: state.through });
      state.poolRows = [...new Map([...state.poolRows, ...cached].map(row => [row.asset, row])).values()];
    }
    // UTC reads take Pool Analysis's own copy of every pool it tracks.
    const missing = state.pools.filter(pool => !(state.timeZone === 'UTC' && options.trackedPools?.has(pool)) && !state.poolRows.some(row => row.asset === pool));
    if (missing.length) {
      const params = new URLSearchParams({ ...financialDetailHistoryQuery(state.from, state.through), pool: missing[0] });
      state.poolRows.push(financialPoolVolume(await getJson(`/history/swaps?${params}`), state, missing[0]));
    }
    if (missing.length <= 1) { state.phase = 'done'; state.observedAt = new Date(now).toISOString(); }
  }
  const payload = state.phase !== 'done' ? null : dayPayload(day, state, now);
  return { state, payload };
}

/** Exact local windows are sums of UTC-day slices. An intraday boundary needs
 * its exact saved prefix; a day-end needs a sealed source total. No nearby
 * snapshot, fallback day or partial total can substitute for either boundary. */
export async function readFinancialPoolWindow(db, assets, { from, through }) {
  if (!assets.length || through <= from) return [];
  const firstDay = iso(from).slice(0, 10), lastDay = iso(through - 1).slice(0, 10);
  const [{ rows: daily }, { rows: prefixes }] = await Promise.all([
    db.query(`select asset, day::text, volume_rune_e8::text, volume_usd_e2::text,
      interval_start, interval_end, partial, source, to_jsonb(daily)->>'completed_at' as completed_at
      from pool_analysis_daily daily where asset = any($1::text[]) and day between $2::date and $3::date`, [assets, firstDay, lastDay]),
    db.query(`select asset, bucket_end, volume_rune_e8::text, volume_usd_e2::text
      from pool_analysis_intraday_snapshots where asset = any($1::text[]) and bucket_end = any($2::timestamptz[])`,
    [assets, [iso(from), iso(through)]])
  ]);
  const days = new Map(daily.map(row => [`${row.asset}:${String(row.day).slice(0, 10)}`, row]));
  const heads = new Map(prefixes.map(row => [`${row.asset}:${new Date(row.bucket_end).getTime() / 1000}`, row]));
  const values = row => row && integer(row.volume_rune_e8) && integer(row.volume_usd_e2)
    ? [BigInt(row.volume_rune_e8), BigInt(row.volume_usd_e2)] : null;
  const totals = [];
  for (const asset of assets) {
    let cursor = from, rune = 0n, usd = 0n, valid = true;
    while (cursor < through) {
      const midnight = Math.floor(cursor / DAY) * DAY, end = Math.min(midnight + DAY, through);
      const startValues = cursor === midnight ? [0n, 0n] : values(heads.get(`${asset}:${cursor}`));
      let endValues;
      if (end === midnight + DAY) {
        const row = days.get(`${asset}:${iso(midnight).slice(0, 10)}`);
        endValues = row && !row.partial && row.completed_at && row.source === 'liquify-midgard-swaps'
          && Date.parse(row.interval_start) / 1000 === midnight && Date.parse(row.interval_end) / 1000 === end
          ? values(row) : null;
      } else endValues = values(heads.get(`${asset}:${end}`));
      if (!startValues || !endValues || endValues.some((value, index) => value < startValues[index])) { valid = false; break; }
      rune += endValues[0] - startValues[0]; usd += endValues[1] - startValues[1]; cursor = end;
    }
    if (valid) totals.push({ asset, volumeRune: Number(rune) / 1e8, volumeUsd: Number(usd) / 100 });
  }
  return totals;
}

/** Stored rows only cover pools Pool Analysis does not track, plus local windows. */
async function financialDayPools(db, day, from, payload, complete) {
  if (payload.timeZone && payload.timeZone !== 'UTC') return topPools(payload.pools || []);
  const { rows } = complete
    ? await db.query(`select asset, volume_usd_e2::text, volume_rune_e8::text from pool_analysis_daily where day = $1::date`, [day])
    // Per tracked pool, so each newest prefix is one primary-key probe.
    : await db.query(`select tracked.asset, latest.volume_usd_e2::text, latest.volume_rune_e8::text
      from pool_analysis_sync_state tracked cross join lateral (select volume_usd_e2, volume_rune_e8
        from pool_analysis_intraday_snapshots where asset = tracked.asset
          and bucket_end >= $1::timestamptz and bucket_end <= $2::timestamptz
        order by bucket_end desc limit 1) latest`, [iso(from), payload.through]);
  const pools = new Map((payload.pools || []).map(row => [row.asset, row]));
  for (const row of rows) {
    if (row.asset && row.volume_usd_e2 != null && row.volume_rune_e8 != null) pools.set(row.asset,
      { asset: row.asset, volumeUsd: Number(row.volume_usd_e2) / 100, volumeRune: Number(row.volume_rune_e8) / 1e8 });
  }
  return topPools([...pools.values()]);
}

/** A covered day ranks verified stream candidates instead of the saved scan's
 * swaps. Unverified top candidates stay disclosed as pending; the saved
 * horizon, pool totals and acquisition state are unchanged. */
async function ledgerPayload(db, day, payload, now) {
  const bounds = financialDetailDay(day, now, payload.timeZone || 'UTC');
  if (!financialSwapLedgerCovers(await readFinancialSwapLedgerStart(db), bounds)) return null;
  const ledger = await readFinancialSwapLedgerDay(db, { ...bounds, to: Date.parse(payload.through) / 1000 }, now);
  const pending = ledger.pending.length;
  const merged = { ...payload, swapSource: 'finalized-block-ledger', swaps: topSwaps(ledger.swaps), pendingSwaps: pending, unpricedSwaps: ledger.unpriced.length,
    excludedSwaps: [...ledger.pending.map(txId => ({ txId, kind: 'pending' })), ...ledger.unpriced.map(txId => ({ txId, kind: 'unpriced' }))],
    exclusionsIncomplete: false, settlement: { status: pending ? 'pending' : 'complete', checkedAt: ledger.checkedAt,
      nextCheckAt: ledger.nextCheckAt, remaining: pending, passCount: 0 } };
  return { ...merged, finalized: financialDaySnapshotFinalized(day, merged, now) };
}

export async function readFinancialDay(day, options = {}) {
  const now = options.now?.() ?? Date.now();
  const bounds = financialDetailDay(day, now, options.timeZone || 'UTC');
  const { from } = bounds;
  const timeZone = bounds.timeZone || 'UTC';
  const db = options.client || await import('../db/pool.js');
  const { rows } = await db.query(`insert into financials_day_rankings (day, time_zone, background, window_start, window_end)
    values ($1::date, $2, $3, $4::timestamptz, $5::timestamptz)
    on conflict (day, time_zone) do update set requested_at = now()
    returning payload_json, state_json->>'phase' as phase, state_json->>'pages' as pages, last_error, available_at`,
  [day, timeZone, financialLocalDay(now, timeZone) === day, iso(from), iso(bounds.to)]);
  const row = rows[0];
  const ledger = row?.payload_json ? await ledgerPayload(db, day, row.payload_json, now) : null;
  const payload = ledger || row?.payload_json;
  const complete = financialDaySnapshotComplete(day, payload);
  const settlement = financialDaySettlement(day, payload);
  const working = !complete || settlement?.status === 'pending';
  if (settlement?.status === 'pending' && !ledger) {
    const eligibleAt = Math.max(Date.parse(settlement.nextCheckAt) || 0, new Date(row?.available_at).getTime() || 0);
    if (eligibleAt > now) settlement.nextCheckAt = new Date(eligibleAt).toISOString();
  }
  const pools = payload && await financialDayPools(db, day, from, payload, complete);
  // Scan rows keep the prices used before top-ten truncation. Repricing just
  // the ten saved winners could miss a previously eleventh-ranked transaction.
  // Ledger reads price every candidate before choosing their winners above.
  return { day, timeZone, windowFrom: iso(from), windowTo: iso(bounds.to), ...(payload || {}), ...(pools && { pools }), loading: !payload,
    ...(complete ? { finalized: financialDaySnapshotFinalized(day, payload, now), settlement } : {}),
    refreshing: Boolean(payload && !complete && new Date(row.available_at).getTime() <= now),
    retryAt: working && row?.last_error ? new Date(row.available_at).toISOString() : null,
    deferred: Boolean(working && row?.last_error && new Date(row.available_at).getTime() > now),
    progress: { phase: settlement?.status === 'pending' ? 'settlement' : complete ? 'done' : row?.phase || (row?.payload_json ? 'done' : 'queued'), pages: Number(row?.pages) || 0 },
    error: working ? row?.last_error || '' : '' };
}

// Eligibility examines retained IDs, never a bare count. CASE protects older
// count-only rows and malformed/non-array JSON without reviving day-wide scans.
const retainedPendingSql = `exists (select 1 from jsonb_array_elements(case
  when jsonb_typeof(payload_json->'excludedSwaps') = 'array' then payload_json->'excludedSwaps' else '[]'::jsonb end) excluded
  where excluded->>'kind' = 'pending' and jsonb_typeof(excluded->'txId') = 'string' and length(btrim(excluded->>'txId')) > 0)`;
const incompleteDaySql = `(payload_json is null or (payload_json->>'through')::timestamptz <
  coalesce(window_end, (payload_json->>'windowTo')::timestamptz, ((day + 1)::timestamp at time zone time_zone)))`;
const settlementDueSql = `(${retainedPendingSql} and coalesce((payload_json->'settlement'->>'nextCheckAt')::timestamptz, '-infinity'::timestamptz) <= $2::timestamptz)`;

export async function refreshFinancialDayQueue(client, options = {}) {
  if (options.signal?.aborted) return;
  const now = options.now?.() ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  // UTC stays maintained without a viewer. A local roster is adopted on read
  // and finishes after its viewer leaves; historical scans retain leases.
  await client.query(`insert into financials_day_rankings (day, time_zone, background, available_at)
    select $1::date, 'UTC', true, $2::timestamptz
    union all select day, time_zone, true, available_at from financials_day_rankings
      where not background and ((day = ($3::timestamptz at time zone time_zone)::date - 1 and ${incompleteDaySql})
        or (not ${incompleteDaySql} and ${retainedPendingSql}))
    on conflict (day, time_zone) do update set background = true where not financials_day_rankings.background`,
  [today, new Date(financialDayRosterReadyAt(today, now)).toISOString(), new Date(now).toISOString()]);
  const { rows } = await client.query(`select day::text, time_zone, state_json, payload_json, requested_at, background from (
      select *, row_number() over (partition by case when not ${incompleteDaySql} then 3
        when background and day = case when time_zone = 'UTC' then $1::date
          else ($2::timestamptz at time zone time_zone)::date end then 0 when background then 1 else 2 end
        order by last_worked_at nulls first, available_at, requested_at, day, time_zone) as lane_rank
      from financials_day_rankings where available_at <= $2::timestamptz
        and (background or requested_at > $2::timestamptz - interval '2 minutes')
        and (${incompleteDaySql} or ${settlementDueSql})
    ) candidates where lane_rank = 1
    order by last_worked_at nulls first, available_at, requested_at, day, time_zone limit 4`, [today, new Date(now).toISOString()]);
  const jobs = rows.filter(row => financialDayNeedsWork(row.day, row.payload_json, now)).map(row => ({
    ...row, timeZone: row.time_zone || 'UTC', requestedAt: row.requested_at ? new Date(row.requested_at).getTime() : now,
    state: row.state_json || financialDayStateFromSnapshot(row.day, row.payload_json, now)
  }));
  const trackedPools = jobs.length ? new Set((await client.query('select asset from pool_analysis_sync_state')).rows
    .map(row => row.asset).filter(Boolean)) : undefined;
  const ledgerStart = jobs.length ? await readFinancialSwapLedgerStart(client) : null;
  const maxRequests = Math.max(1, Math.min(10, Number(options.maxRequests) || 10));
  let requests = 0;
  while (jobs.length && requests < maxRequests && !options.signal?.aborted) {
    const job = jobs.shift();
    const clock = options.now?.() ?? Date.now();
    if (job.background && financialDayRosterReadyAt(job.day, clock, job.timeZone) > clock) continue;
    if (!job.background && clock - job.requestedAt >= FINANCIAL_DAY_VISITOR_LEASE_MS) continue;
    requests++;
    try {
      const bounds = financialDetailDay(job.day, clock, job.timeZone);
      const result = await advanceFinancialDay(job.day, job.state, options.getJson, clock,
        { background: job.background, timeZone: job.timeZone, trackedPools,
          priceSwaps: (swaps, window) => priceFinancialSwapRows(client, swaps, window),
          readPools: (assets, window) => readFinancialPoolWindow(client, assets, window),
          streamSwaps: financialSwapLedgerCovers(ledgerStart, bounds) });
      const savedAt = options.now?.() ?? Date.now();
      const availableAt = financialDayNextWorkAt(job.day, result.payload, savedAt, { background: job.background }) ?? savedAt;
      const saved = await client.query(`update financials_day_rankings set state_json = $2::jsonb,
        payload_json = coalesce($3::jsonb, payload_json), updated_at = $5::timestamptz, last_error = null,
        available_at = $4::timestamptz, last_worked_at = $5::timestamptz where day = $1::date and time_zone = $6 returning requested_at`,
      [job.day, JSON.stringify(result.state), result.payload ? JSON.stringify(result.payload) : null,
        new Date(availableAt).toISOString(), new Date(savedAt).toISOString(), job.timeZone]);
      job.state = result.state;
      if (saved.rows[0]?.requested_at) job.requestedAt = new Date(saved.rows[0].requested_at).getTime();
      if (!result.payload || (financialDaySnapshotComplete(job.day, result.payload)
        && financialDayNeedsWork(job.day, result.payload, savedAt))) jobs.push(job);
    } catch (error) {
      if (options.signal?.aborted) return;
      const failedAt = options.now?.() ?? Date.now();
      const retryAt = financialDayRetryAt(error, failedAt);
      await client.query(`update financials_day_rankings set last_error = $2, available_at = $3::timestamptz,
        last_worked_at = $4::timestamptz where day = $1::date and time_zone = $5`,
      [job.day, error.message, new Date(retryAt).toISOString(), new Date(failedAt).toISOString(), job.timeZone]);
      if (error.code === 'MIDGARD_BUDGET_DEFERRED' || error.skipProvider) return;
    }
  }
}
