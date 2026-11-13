import { fetchMidgardActions, fetchMidgard, MIDGARD_BASES } from './midgard.js';
import { affiliateActionIdentity } from './dynamic-fee-affiliate-ingestion.js';
import { stableSwapCoverageStart } from './dynamic-fee-stable-swaps.js';
import { midgardActionTimestampSeconds } from '../../../shared/dynamic-fees/affiliate-volume.js';
import { isStableSwapRoute, stableSwapSymbol } from '../../../shared/dynamic-fees/stable-swaps.js';

const DAY = 86400;
export const STABLE_SWAP_BACKFILL_DAYS = 90;
// Midgard rejects /actions requests listing more than four assets.
export const MIDGARD_ACTION_ASSET_LIMIT = 4;
const PAGE_LIMIT = '50';
// Midgard may still be aggregating a recent day; scan only settled days.
const SETTLE_SECONDS = 2 * DAY;

const daySeconds = (day) => Date.parse(`${day}T00:00:00Z`) / 1000;
const dayKey = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The 90 UTC days immediately before the live ledger's first covered day. */
export function stableSwapBackfillWindow(ledgerStart) {
  return { ledgerStart, targetStart: dayKey(daySeconds(ledgerStart) - STABLE_SWAP_BACKFILL_DAYS * DAY) };
}

/**
 * Every layer-1, trade (`~`) and secured (`-`) variant of each stable pool,
 * minus one. A stable-to-stable swap always involves two DIFFERENT stable
 * assets and Midgard's `asset` filter is an OR, so a filter that omits exactly
 * one stable asset still returns every stable-to-stable swap: the other side
 * is always listed. The omitted asset is the layer-1 asset of the pool with
 * the largest `volume24h` in /pools (the only traffic figure /pools reports),
 * which removes the most stable-to-non-stable pages from the scan.
 */
export function buildStableSwapAssetFilter(pools) {
  const stable = (Array.isArray(pools) ? pools : [])
    .filter((pool) => /^[A-Z0-9]+\.[^.~]+$/i.test(String(pool?.asset ?? '')) && stableSwapSymbol(pool.asset))
    .map((pool) => ({ asset: String(pool.asset).toUpperCase(), volume: Number(pool.volume24h) || 0 }));
  if (stable.length < 2) throw new Error('Midgard pools list has fewer than two stable pools');
  const omitted = [...stable].sort((a, b) => b.volume - a.volume || a.asset.localeCompare(b.asset))[0].asset;
  const variants = stable.flatMap(({ asset }) => [asset, asset.replace('.', '~'), asset.replace('.', '-')]);
  const assets = [...new Set(variants)].filter((asset) => asset !== omitted).sort();
  return { assets, omitted };
}

export function stableSwapFilterGroups(assets) {
  const groups = [];
  for (let index = 0; index < assets.length; index += MIDGARD_ACTION_ASSET_LIMIT) {
    groups.push(assets.slice(index, index + MIDGARD_ACTION_ASSET_LIMIT));
  }
  return groups;
}

function e8(value, label) {
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`Stable swap action has an invalid ${label} amount`);
  return BigInt(value);
}

/**
 * The stored record for a successful stable-to-stable swap action, else null.
 * Volume matches the live ledger: the inbound coins of the input asset.
 */
export function stableSwapBackfillRecord(action) {
  if (action?.status !== 'success') return null;
  const inbound = (action.in || []).flatMap((leg) => leg?.coins || []);
  const inputAsset = String(inbound[0]?.asset ?? '');
  // Affiliate legs pay a fee, and a partial refund returns the input asset;
  // neither identifies the output. A pending stream names it in outCoin.
  const outputAsset = (action.out || []).filter((leg) => !leg?.affiliate)
    .flatMap((leg) => leg?.coins || []).map((coin) => String(coin?.asset ?? ''))
    .find((asset) => asset && asset !== inputAsset)
    || String(action.metadata?.swap?.streamingSwapMeta?.outCoin?.asset ?? '');
  if (!isStableSwapRoute(inputAsset, outputAsset) || inputAsset === outputAsset) return null;
  const inputE8 = inbound.filter((coin) => coin?.asset === inputAsset)
    .reduce((sum, coin) => sum + e8(coin.amount, 'input'), 0n);
  const fee = action.metadata?.swap?.liquidityFee;
  const actionTime = midgardActionTimestampSeconds(action.date);
  return {
    action_key: affiliateActionIdentity(action),
    day: dayKey(actionTime), action_time: actionTime, height: Number(action.height),
    input_asset: inputAsset, input_e8: String(inputE8), output_asset: outputAsset,
    fee_rune_e8: /^\d+$/.test(String(fee ?? '')) ? String(fee) : null
  };
}

const STATE_SQL = `select ledger_start::text, target_start::text, asset_filter, omitted_asset,
  scan_day::text, group_index, source_base, page_token, seen_tokens_json, day_actions::text,
  completed_at, (available_at <= now()) as available from dynamic_fee_stable_swap_backfill`;

async function loadState(client) {
  const { rows = [] } = await client.query(STATE_SQL);
  return rows[0] || null;
}

async function initialize(client, nowMs, options) {
  const { rows = [] } = await client.query('select fee_started_at from financials_swap_ledger limit 1');
  const ledgerStart = stableSwapCoverageStart(rows[0]?.fee_started_at);
  if (!ledgerStart || daySeconds(ledgerStart) > nowMs / 1000) return null;
  const { targetStart } = stableSwapBackfillWindow(ledgerStart);
  const base = (options.bases || MIDGARD_BASES)[0];
  const pools = await (options.fetchMidgard || fetchMidgard)('/pools', { bases: [base], cooldownClient: client,
    validateResponse: (_path, value) => !Array.isArray(value) });
  const filter = buildStableSwapAssetFilter(pools);
  await client.query(`insert into dynamic_fee_stable_swap_backfill
      (ledger_start, target_start, asset_filter, omitted_asset, scan_day)
    values ($1::date, $2::date, $3::jsonb, $4, $1::date - 1) on conflict (id) do nothing`,
  [ledgerStart, targetStart, JSON.stringify(filter.assets), filter.omitted]);
  return loadState(client);
}

async function savePage(client, records, update) {
  await client.query('begin');
  try {
    if (records.length) await client.query(`insert into dynamic_fee_stable_swap_backfill_swaps
        (action_key, day, action_time, height, input_asset, input_e8, output_asset, fee_rune_e8)
      select action_key, day, action_time, height, input_asset, input_e8, output_asset, fee_rune_e8
      from jsonb_to_recordset($1::jsonb) as r(action_key text, day date, action_time bigint, height bigint,
        input_asset text, input_e8 numeric, output_asset text, fee_rune_e8 numeric)
      on conflict (action_key) do nothing`, [JSON.stringify(records)]);
    await update();
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
}

/** RUNE/USD for one UTC day from Midgard's daily history, or null if absent. */
async function fetchDayRunePrice(client, state, options) {
  const from = daySeconds(state.scan_day);
  const params = new URLSearchParams({ interval: 'day', from: String(from), to: String(from + DAY) });
  const payload = await (options.fetchMidgard || fetchMidgard)(`/history/rune?${params}`, {
    bases: [state.source_base], cooldownClient: client,
    validateResponse: (_path, value) => !Array.isArray(value?.intervals) });
  const interval = payload.intervals.find((row) => Number(row?.startTime) === from && Number(row?.endTime) === from + DAY);
  const price = Number(interval?.runePriceUSD);
  return Number.isFinite(price) && price > 0 ? String(interval.runePriceUSD) : null;
}

/** Fetches and stores one page of the current day and filter group. */
async function scanPage(client, state, options, stats) {
  const start = daySeconds(state.scan_day);
  const end = start + DAY;
  const groups = stableSwapFilterGroups(state.asset_filter || []);
  const group = groups[state.group_index];
  if (!group) throw new Error('Stable swap backfill filter group is missing');
  const token = state.page_token || '';
  const seenTokens = new Set(state.seen_tokens_json || []);
  const payload = await (options.fetchActions || fetchMidgardActions)({
    type: 'swap', asset: group.join(','), limit: PAGE_LIMIT, timestamp: String(end),
    // Midgard's lower bound is exclusive: overlap one second and filter locally
    // so an action exactly at UTC midnight belongs to its day.
    ...(token ? { prevPageToken: token } : { fromTimestamp: String(start - 1) })
  }, { bases: [state.source_base], cooldownClient: client });
  if (!Array.isArray(payload?.actions)) throw new Error('Invalid stable swap actions page');
  stats.pages += 1;
  let reachedEnd = false;
  let inDay = 0;
  const records = [];
  for (const action of payload.actions) {
    const timestamp = midgardActionTimestampSeconds(action?.date);
    if (!(timestamp > 0) || !(Number(action?.height) > 0)) throw new Error('Stable swap action is missing its timestamp or height');
    if (timestamp >= end) { reachedEnd = true; continue; }
    if (timestamp < start) continue;
    inDay += 1;
    const record = stableSwapBackfillRecord(action);
    if (record) records.push(record);
  }
  const next = String(payload?.meta?.prevPageToken || '');
  const complete = reachedEnd || payload.actions.length === 0;
  if (!complete && !next) throw new Error('Midgard nonempty stable swap page is missing its continuation token');
  if (!complete && (next === token || seenTokens.has(next))) throw new Error('Midgard repeated a stable swap page token');
  stats.swaps += records.length;
  const dayActions = Number(state.day_actions || 0) + inDay;

  if (!complete) {
    seenTokens.add(next);
    await savePage(client, records, () => client.query(`update dynamic_fee_stable_swap_backfill set
      page_token = $1, seen_tokens_json = $2::jsonb, day_actions = $3, last_error = null, updated_at = now()`,
    [next, JSON.stringify([...seenTokens]), dayActions]));
    return { ...state, page_token: next, seen_tokens_json: [...seenTokens], day_actions: dayActions };
  }
  if (state.group_index + 1 < groups.length) {
    await savePage(client, records, () => client.query(`update dynamic_fee_stable_swap_backfill set
      group_index = group_index + 1, page_token = '', seen_tokens_json = '[]', day_actions = $1,
      last_error = null, updated_at = now()`, [dayActions]));
    return { ...state, group_index: state.group_index + 1, page_token: '', seen_tokens_json: [], day_actions: dayActions };
  }
  // The day's last terminal page, its price and the move to the previous day
  // commit together; a failure before this point replays the page idempotently.
  const price = await fetchDayRunePrice(client, state, options);
  const last = state.scan_day <= state.target_start;
  await savePage(client, records, async () => {
    await client.query(`insert into dynamic_fee_stable_swap_backfill_days (day, rune_price_usd, actions_scanned, swaps)
      select $1::date, $2::numeric, $3, count(*) from dynamic_fee_stable_swap_backfill_swaps where day = $1::date
      on conflict (day) do update set rune_price_usd = excluded.rune_price_usd,
        actions_scanned = excluded.actions_scanned, swaps = excluded.swaps, completed_at = now()`,
    [state.scan_day, price, dayActions]);
    await client.query(`update dynamic_fee_stable_swap_backfill set
      scan_day = case when $1 then null else scan_day - 1 end,
      completed_at = case when $1 then now() end,
      group_index = 0, source_base = null, page_token = '', seen_tokens_json = '[]', day_actions = 0,
      last_error = null, updated_at = now()`, [last]);
  });
  stats.days_completed += 1;
  return last ? null : { ...state, scan_day: dayKey(start - DAY), group_index: 0, source_base: null,
    page_token: '', seen_tokens_json: [], day_actions: 0 };
}

/**
 * Advances the pre-ledger stable swap history by at most `maxPages` Midgard
 * action pages, one UTC day at a time, newest day first. Errors are recorded
 * on the state row and returned, never thrown, so callers keep running.
 */
export async function advanceStableSwapBackfill(client, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxPages = Math.max(1, Math.min(20, Number(options.maxPages) || 1));
  const stats = { status: 'waiting', pages: 0, days_completed: 0, swaps: 0 };
  let state = await loadState(client);
  if (state?.completed_at) return { ...stats, status: 'done' };
  if (state && !state.available) return stats;
  try {
    if (!state) state = await initialize(client, nowMs, options);
    if (!state) return stats;
    stats.status = 'scanning';
    while (state && stats.pages < maxPages) {
      if (daySeconds(state.scan_day) + DAY > nowMs / 1000 - SETTLE_SECONDS) { stats.status = 'waiting'; break; }
      if (!state.source_base) {
        const base = (options.bases || MIDGARD_BASES)[0];
        await client.query('update dynamic_fee_stable_swap_backfill set source_base = $1, updated_at = now()', [base]);
        state = { ...state, source_base: base };
      }
      state = await scanPage(client, state, options, stats);
    }
    if (!state) stats.status = 'done';
  } catch (error) {
    stats.error = error?.message || String(error);
    const retryAt = Number.isFinite(Date.parse(error?.retryAt)) ? new Date(error.retryAt).toISOString() : null;
    await client.query(`update dynamic_fee_stable_swap_backfill set last_error = $1,
      available_at = coalesce($2::timestamptz, now() + interval '5 minutes'), updated_at = now()`, [stats.error, retryAt]);
  }
  return stats;
}
