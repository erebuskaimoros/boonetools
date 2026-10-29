import { financialCalendarWindow } from '../../../shared/financials/day-window.js';
import { priceFinancialSwapRows } from './financials-swap-pricing.js';

/** Reuse the Financials verifier's request limit, cooldowns and saved IDs. Each
 * pool gets its own candidate selection before the bounded batch is chosen. */
export async function loadPoolSwapVerificationCandidates(client, now) {
  const { rows } = await client.query(`with windows as (
      select start_at as window_from, start_at + interval '24 hours' as window_to, null::text as asset
      from generate_series(date_trunc('day', $1::timestamptz at time zone 'UTC') at time zone 'UTC' - interval '3 days',
        date_trunc('day', $1::timestamptz at time zone 'UTC') at time zone 'UTC', interval '24 hours') start_at
      union select window_start, window_end, asset from financials_pool_swap_windows
        where window_end >= $1::timestamptz - interval '3 days' or requested_at > $1::timestamptz - interval '2 minutes'
      union select window_from, window_to, null::text from financials_swap_verification_windows remembered
        join financials_swap_candidates waiting on waiting.tx_id = remembered.tx_id
        where waiting.status in ('observed','pending') and waiting.complete
          and coalesce(waiting.next_check_at, waiting.completed_at + interval '2 minutes') <= $1::timestamptz
    ) select distinct candidate.tx_id, candidate.status, candidate.checks, candidate.next_check_at, candidate.complete,
      candidate.completed_at, candidate.first_seen_at, fees.fee_rune_e8::text, candidate.verified_row,
      fees.asset as pool_asset, windows.window_from, windows.window_to
    from windows join financials_swap_candidates candidate on candidate.started
      and candidate.first_seen_at >= greatest(windows.window_from, (select pool_started_at from financials_swap_ledger))
      and candidate.first_seen_at < windows.window_to
    join financials_swap_pool_fees fees on fees.tx_id = candidate.tx_id
      and (windows.asset is null or windows.asset = fees.asset)
    where candidate.status <> 'excluded'`, [new Date(now).toISOString()]);
  return rows;
}

const iso = value => value == null ? null : new Date(value).toISOString();
const order = (a, b) => (b.feeUsd ?? -1) - (a.feeUsd ?? -1) || b.feeRune - a.feeRune || a.txId.localeCompare(b.txId);

/** Database-only day detail. It is deliberately incapable of backfilling a
 * missing day: pool fees exist only from the new finalized-event capture. */
export async function readFinancialPoolSwapDay(client, asset, day, { timeZone = 'UTC', now = Date.now() } = {}) {
  const bounds = financialCalendarWindow(day, now, timeZone);
  const zone = bounds.timeZone || 'UTC';
  const windowFrom = new Date(bounds.from * 1000).toISOString(), windowTo = new Date(bounds.to * 1000).toISOString();
  const { rows: [ledger] } = await client.query('select pool_started_at from financials_swap_ledger');
  const trackingSince = iso(ledger?.pool_started_at);
  const trackingStart = trackingSince ? Date.parse(trackingSince) : Infinity;
  const payload = { day, timeZone: zone, asset, windowFrom, windowTo, trackingSince,
    swapSource: 'finalized-block-ledger', swapRankingBasis: 'pool-liquidity-fees-usd',
    swaps: [], pendingSwaps: 0, unpricedSwaps: 0, loading: false, partial: bounds.to * 1000 > now };
  if (bounds.to * 1000 <= trackingStart) return { ...payload, availability: 'before-tracking', partial: false };
  const captureFrom = Math.max(bounds.from * 1000, trackingStart);
  const coverageFrom = new Date(captureFrom).toISOString();
  await client.query(`insert into financials_pool_swap_windows(asset,day,time_zone,window_start,window_end,requested_at)
    values ($1,$2,$3,$4,$5,$6) on conflict (asset,day,time_zone) do update set requested_at = excluded.requested_at`,
  [asset, day, zone, windowFrom, windowTo, new Date(now).toISOString()]);

  // The existing finalized-block ledger supplies independent boundaries. A gap
  // cannot silently turn a partial ranking into a complete permanent result.
  const { rows: [coverage] } = await client.query(`with bounds as (
      select (select height from system_income_pol_blocks where block_time < $1::timestamptz order by height desc limit 1) as previous,
        (select height from system_income_pol_blocks where block_time >= $1::timestamptz order by height limit 1) as first,
        (select height from system_income_pol_blocks where block_time >= $2::timestamptz order by height limit 1) as following,
        (select max(height) from system_income_pol_blocks where block_time < $2::timestamptz) as last
    ) select coalesce(previous + 1, first)::text as first_height, coalesce(following - 1, last)::text as last_height,
      previous is not null as start_bounded, following is not null as end_bounded,
      (select max(block_time) from system_income_pol_blocks) as head_time,
      count(block.height)::int as captured, count(block.height) filter (where not block.attribution_complete)::int as unattributed,
      max(block.block_time) as through
    from bounds left join financials_pool_swap_blocks block
      on block.height between coalesce(previous + 1, first) and coalesce(following - 1, last)
      and block.block_time >= $1::timestamptz and block.block_time < $2::timestamptz
    group by previous, first, following, last`, [coverageFrom, windowTo]);
  const expected = coverage.first_height && coverage.last_height
    ? Math.max(0, Number(coverage.last_height) - Number(coverage.first_height) + 1) : null;
  const missingBlocks = expected === null ? null : Math.max(0, expected - coverage.captured);
  const stale = !coverage.head_time || now - new Date(coverage.head_time).getTime() > 120_000;
  const complete = missingBlocks === 0 && coverage.unattributed === 0 && coverage.start_bounded
    && (coverage.end_bounded || payload.partial && !stale);

  const { rows } = await client.query(`select candidate.*, fees.fee_rune_e8::text as pool_fee_rune_e8
    from financials_swap_pool_fees fees join financials_swap_candidates candidate using(tx_id)
    where fees.asset = $1 and candidate.started and candidate.first_seen_at >= $2::timestamptz
      and candidate.first_seen_at < $3::timestamptz order by candidate.first_seen_at, candidate.tx_id`,
  [asset, coverageFrom, windowTo]);
  const priced = await priceFinancialSwapRows(client, rows.map(row => ({ ...row.verified_row,
    txId: row.tx_id, timestamp: iso(row.first_seen_at), feeRune: Number(row.pool_fee_rune_e8) / 1e8 })),
  { from: captureFrom / 1000, to: bounds.to });
  const byId = new Map(rows.map(row => [row.tx_id, row]));
  const ranked = priced.filter(row => byId.get(row.txId).status !== 'excluded').sort(order);
  const leaders = [...ranked.filter(row => row.feeUsd !== null).slice(0, 25), ...ranked.filter(row => row.feeUsd === null).slice(0, 25)];
  const pending = new Set([...leaders, ...ranked.filter(row => !byId.get(row.txId).complete)]
    .filter(row => ['observed', 'pending'].includes(byId.get(row.txId).status)).map(row => row.txId));
  const checks = rows.filter(row => row.checks > 0).map(row => new Date(row.updated_at).getTime());
  const due = rows.filter(row => pending.has(row.tx_id) && row.complete)
    .map(row => new Date(row.next_check_at || new Date(row.completed_at).getTime() + 120_000).getTime()).filter(Number.isFinite);
  return { ...payload, availability: 'tracked', coverageFrom, partialCoverage: captureFrom > bounds.from * 1000,
    coverageComplete: complete, missingBlocks, unattributedBlocks: coverage.unattributed,
    stale: !coverage.end_bounded && stale, through: iso(coverage.through),
    swaps: ranked.filter(row => byId.get(row.txId).status === 'verified' && row.feeUsd !== null).slice(0, 10),
    pendingSwaps: pending.size,
    unpricedSwaps: priced.filter(row => byId.get(row.txId).status === 'verified' && row.feeUsd === null
      || byId.get(row.txId).status === 'excluded' && byId.get(row.txId).last_error === 'unpriced').length,
    refreshing: !complete,
    settlement: { status: pending.size ? 'pending' : 'complete',
      checkedAt: checks.length ? iso(Math.max(...checks)) : null,
      nextCheckAt: due.length ? iso(Math.max(now, Math.min(...due))) : null }
  };
}
