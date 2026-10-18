import { midgardActionTimestampSeconds } from '../../../shared/dynamic-fees/affiliate-volume.js';

const DAY = 86400;
const REFRESH_MS = 15 * 60_000;
const iso = seconds => new Date(seconds * 1000).toISOString();
const positive = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const integer = value => /^\d+$/.test(String(value ?? ''));

export function financialDetailDay(day, now = Date.now()) {
  const from = Date.parse(`${day}T00:00:00Z`) / 1000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !Number.isFinite(from)
    || iso(from).slice(0, 10) !== day || day < '2021-04-13' || from > now / 1000) {
    throw new Error('Day must be a valid UTC date from 2021-04-13 through today');
  }
  return { day, from, to: from + DAY };
}

function rankedSwaps(actions, from, through) {
  const rows = [];
  let unpriced = 0, pending = 0;
  for (const action of actions) {
    const seconds = midgardActionTimestampSeconds(action.date);
    if (seconds < from || seconds >= through || action.type !== 'swap') continue;
    if (action.status !== 'success') { pending++; continue; }
    const inputs = (action.in || []).flatMap(leg => leg.coins || []);
    const asset = inputs[0]?.asset;
    const txId = action.in?.find(leg => leg.txID)?.txID;
    const price = action.metadata?.swap?.inPriceUSD;
    // One source asset per route. Never turn an unpriced swap into a zero.
    if (!txId || !inputs.length || !positive(price) || inputs.some(coin => coin.asset !== asset || !integer(coin.amount))) {
      unpriced++; continue;
    }
    const inputAmount = Number(inputs.reduce((sum, coin) => sum + BigInt(coin.amount), 0n)) / 1e8;
    const volumeUsd = inputAmount * Number(price);
    if (!Number.isFinite(volumeUsd)) { unpriced++; continue; }
    const outputs = (action.out || []).filter(leg => !leg.affiliate).flatMap(leg => leg.coins || []);
    rows.push({ txId: String(txId).toUpperCase(), timestamp: iso(seconds),
      inputAsset: asset, inputAmount, outputAsset: outputs[0]?.asset || action.metadata?.swap?.streamingSwapMeta?.outCoin?.asset || '',
      volumeUsd, streaming: Boolean(action.metadata?.swap?.isStreamingSwap) });
  }
  return { rows, unpriced, pending };
}

function topSwaps(rows) {
  return [...new Map(rows.map(row => [row.txId, row])).values()]
    .sort((a, b) => b.volumeUsd - a.volumeUsd || a.txId.localeCompare(b.txId)).slice(0, 10);
}

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
  const daily = through - from === DAY;
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
 * and opaque descending cursor survive both provider errors and restarts. */
export async function advanceFinancialDay(day, previous, getJson, now = Date.now()) {
  const bounds = financialDetailDay(day, now);
  const state = previous ? structuredClone(previous) : { ...bounds, phase: 'health', swaps: [], pools: [], poolRows: [], tokens: [], pages: 0, unpriced: 0, pending: 0 };
  if (state.phase === 'health') {
    const health = await getJson('/health');
    const watermark = Number(health?.lastAggregated?.timestamp);
    if (health?.inSync !== true || !positive(watermark)) throw new Error('Midgard day-detail source is delayed');
    state.through = Math.min(bounds.to, Math.floor(Math.min(watermark, now / 1000) / 300) * 300);
    if (state.through <= bounds.from) throw new Error('Waiting for the first indexed five-minute bucket');
    state.phase = 'earnings';
  } else if (state.phase === 'earnings') {
    const params = new URLSearchParams(financialDetailHistoryQuery(state.from, state.through));
    state.pools = poolsFromEarnings(await getJson(`/history/earnings?${params}`), state.from, state.through);
    state.phase = 'actions';
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
      if (timestamp < state.from) finished = true;
      if (timestamp >= state.from && timestamp < state.through) {
        for (const pool of action.pools || []) if (/^[A-Z0-9]+\./.test(pool) && !state.pools.includes(pool)) state.pools.push(pool);
      }
    }
    const ranked = rankedSwaps(payload.actions, state.from, state.through);
    state.swaps = topSwaps([...state.swaps, ...ranked.rows]);
    state.unpriced += ranked.unpriced; state.pending += ranked.pending; state.pages++;
    if (finished) state.phase = 'pools';
    else {
      const token = String(payload.meta?.nextPageToken || '');
      if (!token || state.tokens.includes(token)) throw new Error('Day swap pagination did not advance');
      if (state.pages > 10000) throw new Error('Day swap scan exceeded its safety limit');
      state.tokens.push(token); state.token = token;
    }
  } else if (state.phase === 'pools') {
    const asset = state.pools.find(pool => !state.poolRows.some(row => row.asset === pool));
    if (asset) {
      const params = new URLSearchParams({ ...financialDetailHistoryQuery(state.from, state.through), pool: asset });
      state.poolRows.push(financialPoolVolume(await getJson(`/history/swaps?${params}`), state, asset));
    }
    if (state.poolRows.length === state.pools.length) state.phase = 'done';
  }
  const payload = state.phase !== 'done' ? null : {
    day, through: iso(state.through), observedAt: new Date(now).toISOString(),
    partial: state.through < state.to, unpricedSwaps: state.unpriced, pendingSwaps: state.pending,
    finalized: state.through === state.to && !state.unpriced && !state.pending && now / 1000 >= state.to + 2 * DAY,
    swaps: state.swaps, pools: state.poolRows.filter(row => row.volumeUsd > 0).sort((a, b) => b.volumeUsd - a.volumeUsd || a.asset.localeCompare(b.asset)).slice(0, 10),
    swapVolumeBasis: 'input-notional-usd', poolVolumeBasis: 'executed-leg-usd', source: 'liquify-midgard'
  };
  return { state, payload };
}

export async function readFinancialDay(day, options = {}) {
  financialDetailDay(day, options.now?.() ?? Date.now());
  const db = options.client || await import('../db/pool.js');
  const { rows } = await db.query(`insert into financials_day_details (day) values ($1::date)
    on conflict (day) do update set requested_at = now()
    returning payload_json, state_json->>'phase' as phase, state_json->>'pages' as pages, last_error, available_at`, [day]);
  const row = rows[0];
  return { day, ...(row?.payload_json || {}), loading: !row?.payload_json,
    refreshing: Boolean(row?.payload_json && !row.payload_json.finalized && new Date(row.available_at).getTime() <= (options.now?.() ?? Date.now())),
    progress: { phase: row?.phase || (row?.payload_json ? 'done' : 'queued'), pages: Number(row?.pages) || 0 }, error: row?.last_error || '' };
}

export async function refreshFinancialDayQueue(client, options = {}) {
  const { rows } = await client.query(`select day::text, state_json from financials_day_details
    where available_at <= now() and requested_at > now() - interval '7 days'
      and coalesce((payload_json->>'finalized')::boolean, false) = false
    order by available_at, requested_at limit 1`);
  const row = rows[0];
  if (!row) return;
  let state = row.state_json;
  try {
    for (let index = 0; index < Math.max(1, Math.min(10, Number(options.maxRequests) || 10)) && !options.signal?.aborted; index++) {
      const result = await advanceFinancialDay(row.day, state, options.getJson, options.now?.() ?? Date.now());
      state = result.state;
      await client.query(`update financials_day_details set state_json = $2::jsonb,
        payload_json = coalesce($3::jsonb, payload_json), updated_at = now(), last_error = null,
        available_at = now() + ($4 * interval '1 millisecond') where day = $1::date`,
      [row.day, result.payload ? null : JSON.stringify(state), result.payload ? JSON.stringify(result.payload) : null, result.payload ? REFRESH_MS : 0]);
      if (result.payload) return;
    }
  } catch (error) {
    await client.query(`update financials_day_details set last_error = $2, available_at = now() + interval '1 minute' where day = $1::date`, [row.day, error.message]);
  }
}
