import { reconcileTcPoolFees } from '../../../shared/tc-fee-composition.js';

const dayKey = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);

export async function buildTcFeeComposition(client, windows, { now = Date.now() } = {}) {
  const daily = windows.filter(row => row.period === 'day');
  if (!daily.length) return { rows: [], sourceUpdatedAt: null };
  const { rows: history } = await client.query(
    `select day, jsonb_agg(jsonb_build_object(
              'pool', asset, 'totalLiquidityFeesRune', fees_rune_e8::text,
              'partial', partial or completed_at is null
            ) order by asset) as pools, max(updated_at) as updated_at
     from pool_analysis_daily
     where day between $1::date and $2::date
     group by day order by day`,
    [dayKey(daily[0].window_start), dayKey(daily.at(-1).window_start)]
  );
  const byDay = new Map(history.map(row => [dayKey(row.day), row.pools]));
  const today = new Date(now).toISOString().slice(0, 10);
  let sourceUpdatedAt = 0;
  for (const row of history) sourceUpdatedAt = Math.max(sourceUpdatedAt, Date.parse(row.updated_at) || 0);
  const rows = daily.map(row => {
    let source = 'cached-earnings';
    let fees = reconcileTcPoolFees(row.earnings_pools, row.tc_fees_rune, row.tc_fees_usd);
    if (!fees) {
      source = 'cached-pool-history';
      fees = reconcileTcPoolFees(byDay.get(dayKey(row.window_start)), row.tc_fees_rune, row.tc_fees_usd);
    }
    return { day: dayKey(row.window_start), partial: dayKey(row.window_start) >= today,
      totalFeesUsd: row.tc_fees_usd == null ? null : Number(row.tc_fees_usd),
      fees, complete: Boolean(fees), source: fees ? source : 'unavailable' };
  });
  return { rows, sourceUpdatedAt: sourceUpdatedAt ? new Date(sourceUpdatedAt).toISOString() : null };
}
