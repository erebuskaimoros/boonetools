import { recordAcquisitionMetric } from '../lib/acquisition-metrics.js';

const DAY = 86400;
const integer = value => typeof value === 'string' && /^\d+$/.test(value);

function completedPoolRequest(route) {
  const url = new URL(route, 'https://financials.invalid');
  const params = url.searchParams;
  if (url.pathname !== '/history/swaps' || params.get('interval') !== 'day' || params.get('count') !== '1'
    || [...params.keys()].some(key => !['pool', 'interval', 'count', 'from'].includes(key))) return null;
  const from = Number(params.get('from'));
  const asset = params.get('pool')?.trim().toUpperCase();
  if (!asset || !/^[A-Z0-9]+\./.test(asset) || !params.has('from')
    || !Number.isSafeInteger(from) || from < 0 || from % DAY !== 0) return null;
  return { asset, from, to: from + DAY, day: new Date(from * 1000).toISOString().slice(0, 10) };
}

/** Reuse the exact, watermark-verified pool history already owned by Pool
 * Analysis. A cached subset never replaces discovery of the day's pool
 * universe; the caller still asks for every earnings/actions-discovered pool.
 * Cache misses use the same globally budgeted provider as every other step. */
export function createFinancialDaySource({ client, getJson }) {
  return async route => {
    const window = completedPoolRequest(route);
    if (!window) return getJson(route);
    const { rows } = await client.query(`select asset, day::text, volume_rune_e8::text, volume_usd_e2::text,
        interval_start, interval_end, partial, source, completed_at
      from pool_analysis_daily where asset = $1 and day = $2::date`, [window.asset, window.day]);
    const row = rows[0];
    if (row?.asset === window.asset && row.day === window.day && row.partial === false
      && row.source === 'liquify-midgard-swaps'
      && new Date(row.completed_at || '').getTime() >= window.to * 1000
      && new Date(row.interval_start).getTime() === window.from * 1000
      && new Date(row.interval_end).getTime() === window.to * 1000
      && integer(row.volume_rune_e8) && integer(row.volume_usd_e2)) {
      recordAcquisitionMetric('financials-pool-day', 'hit');
      return { intervals: [{ startTime: String(window.from), endTime: String(window.to),
        totalVolume: row.volume_rune_e8, totalVolumeUSD: row.volume_usd_e2 }] };
    }
    recordAcquisitionMetric('financials-pool-day', 'miss');
    return getJson(route);
  };
}
