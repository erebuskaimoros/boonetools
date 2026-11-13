import {
  STABLE_SWAP_ASSET_PATTERN,
  STABLE_SWAP_SYMBOLS,
  buildStableSwapDays
} from '../../../shared/dynamic-fees/stable-swaps.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const STABLE_SWAP_SOURCE = 'finalized-block swap ledger';

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** First UTC day whose fees are fully recorded: a midnight start counts, a mid-day start does not. */
export function stableSwapCoverageStart(feeStartedAt) {
  if (feeStartedAt == null) return null;
  const ms = feeStartedAt instanceof Date ? feeStartedAt.getTime() : Date.parse(String(feeStartedAt));
  if (!Number.isFinite(ms)) return null;
  const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
  return dayKey(ms === dayStart ? dayStart : dayStart + DAY_MS);
}

/** Inclusive UTC day range for a request, or null when coverage has not begun. */
export function stableSwapDayRange({ coverageStart, days, nowMs }) {
  if (!coverageStart) return null;
  const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const toDay = dayKey(todayMs);
  const windowStart = dayKey(todayMs - (days - 1) * DAY_MS);
  return { fromDay: coverageStart > windowStart ? coverageStart : windowStart, toDay };
}

// Live fee USD uses the RUNE price implied by each swap itself: the input is
// a stablecoin, so input_e8 / rune_value_e8 is USD per RUNE at that block.
// Backfilled fee USD uses Midgard's daily RUNE/USD for the swap's UTC day. A
// row is unpriced when its fee is unknown, or nonzero with no RUNE price.
function stableSwapDaysSql(source, feeUsd, filter) {
  return `
  with priced as (
    select day, input_asset, output_asset, input_e8, fee_rune_e8,
      case
        when fee_rune_e8 is null then null
        when fee_rune_e8 = 0 then 0
        else ${feeUsd}
      end as fee_usd_e8
    from ${source}
    where day >= $1::date and day <= $2::date
      and input_asset ~* $3 and output_asset ~* $3
      and ${filter}
  )
  select day::text as day, input_asset, output_asset,
    count(*)::text as swaps,
    sum(input_e8)::text as input_e8,
    coalesce(sum(fee_rune_e8), 0)::text as fee_rune_e8,
    sum(fee_usd_e8)::text as fee_usd_e8,
    count(*) filter (where fee_usd_e8 is null)::text as unpriced_swaps
  from priced
  group by day, input_asset, output_asset
  order by day, input_asset, output_asset`;
}

const LEDGER_DAYS_SQL = stableSwapDaysSql('financials_swap_candidates',
  'case when rune_value_e8 > 0 then round(fee_rune_e8 * input_e8 / rune_value_e8) end', "status <> 'excluded'");
// A stream straddling the ledger start is served by the ledger day that owns
// it. Ledger rows dated before the ledger start (pre-fee input-value
// candidates) are not served live, so they do not suppress backfilled swaps.
const BACKFILL_DAYS_SQL = stableSwapDaysSql(`(select backfill.*, price.rune_price_usd
      from dynamic_fee_stable_swap_backfill_swaps backfill
      join dynamic_fee_stable_swap_backfill_days price on price.day = backfill.day) backfill`,
  'case when rune_price_usd > 0 then round(fee_rune_e8 * rune_price_usd) end', `not exists (
        select 1 from financials_swap_candidates ledger
        where ledger.tx_id = any(string_to_array(backfill.action_key, ':')) and ledger.day >= $4::date)`);

const dayBefore = day => dayKey(Date.parse(`${day}T00:00:00Z`) - DAY_MS);

/** Backfill progress: days are served contiguously back from the ledger start. */
export async function readStableSwapBackfillProgress(client) {
  const { rows: states = [] } = await client.query(`select ledger_start::text, target_start::text, completed_at
    from dynamic_fee_stable_swap_backfill`);
  const state = states[0];
  if (!state) return { state: null, progress: null };
  const { rows: days = [] } = await client.query(`select day::text from dynamic_fee_stable_swap_backfill_days
    where day >= $1::date and day < $2::date order by day desc`, [state.target_start, state.ledger_start]);
  let expected = dayBefore(state.ledger_start);
  let completeFrom = null;
  for (const { day } of days) {
    if (day !== expected) break;
    completeFrom = day;
    expected = dayBefore(day);
  }
  return {
    state,
    progress: {
      target_start: state.target_start,
      complete_from: completeFrom,
      complete: Boolean(state.completed_at),
      floor_reason: null
    }
  };
}

// The stable-to-stable minimum swap fee (global and per-asset overrides).
const STABLE_SWAP_MIMIR_PREFIX = 'STABLESLIPMINBPS';

/** Dated value changes per key; repeats of an unchanged value are dropped. */
export function buildStableSwapMimirChanges(rows = []) {
  const last = new Map();
  const changes = [];
  for (const row of rows) {
    const key = String(row?.mimir_key ?? '').trim().toUpperCase();
    const time = row?.block_time instanceof Date ? row.block_time.getTime() : Date.parse(String(row?.block_time ?? ''));
    const value = String(row?.mimir_value ?? '').trim();
    if (!key.startsWith(STABLE_SWAP_MIMIR_PREFIX) || !Number.isFinite(time) || value === '') continue;
    const previous = last.has(key) ? last.get(key) : null;
    last.set(key, value);
    if (previous === value) continue;
    changes.push({ key, value, previous_value: previous, time: new Date(time).toISOString(),
      day: dayKey(time), height: Number(row.height) || null });
  }
  return changes;
}

export async function readStableSwapMimirChanges(client) {
  const { rows = [] } = await client.query(`select mimir_key, mimir_value, height, block_time
    from protocol_mimir_changes
    where upper(mimir_key) like $1 and block_time is not null
    order by height, event_index`, [`${STABLE_SWAP_MIMIR_PREFIX}%`]);
  return buildStableSwapMimirChanges(rows);
}

export async function readStableSwapDays(client, { days, nowMs = Date.now() }) {
  const payload = {
    as_of: new Date(nowMs).toISOString(),
    coverage_start: null,
    ledger_start: null,
    stable_symbols: [...STABLE_SWAP_SYMBOLS],
    source: STABLE_SWAP_SOURCE,
    backfill: null,
    mimir_changes: [],
    days: []
  };

  const { rows: ledger = [] } = await client.query('select fee_started_at from financials_swap_ledger limit 1');
  const ledgerStart = stableSwapCoverageStart(ledger[0]?.fee_started_at);
  const { state, progress } = await readStableSwapBackfillProgress(client);
  payload.ledger_start = ledgerStart;
  payload.mimir_changes = await readStableSwapMimirChanges(client);
  payload.backfill = progress;
  payload.coverage_start = ledgerStart;
  // Backfill days belong to the ledger start they were scanned against.
  const backfillFrom = state?.ledger_start === ledgerStart ? progress?.complete_from ?? null : null;
  const range = stableSwapDayRange({ coverageStart: backfillFrom ?? ledgerStart, days, nowMs });
  if (!range || range.fromDay > range.toDay) return payload;

  const { rows = [] } = await client.query(LEDGER_DAYS_SQL, [ledgerStart > range.fromDay ? ledgerStart : range.fromDay,
    range.toDay, STABLE_SWAP_ASSET_PATTERN]);
  if (backfillFrom && range.fromDay < ledgerStart) {
    const lastBackfillDay = dayBefore(ledgerStart);
    const { rows: backfilled = [] } = await client.query(BACKFILL_DAYS_SQL, [range.fromDay,
      lastBackfillDay < range.toDay ? lastBackfillDay : range.toDay, STABLE_SWAP_ASSET_PATTERN, ledgerStart]);
    rows.unshift(...backfilled);
  }
  payload.days = buildStableSwapDays(rows, { ...range, currentDay: range.toDay });
  payload.coverage_start = payload.days[0]?.day ?? ledgerStart;
  return payload;
}
