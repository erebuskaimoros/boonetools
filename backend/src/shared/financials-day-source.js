import { recordAcquisitionMetric } from '../lib/acquisition-metrics.js';

const DAY = 86400;
const PREFIX_SECONDS = 900;
const integer = value => typeof value === 'string' && /^\d+$/.test(value);
const timestamp = value => (value instanceof Date || (typeof value === 'string' && value.trim()))
  ? new Date(value).getTime() : NaN;

function poolRequest(route) {
  const url = new URL(route, 'https://financials.invalid');
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (url.pathname !== '/history/swaps' || keys.length !== 4 || new Set(keys).size !== 4
    || keys.some(key => !['pool', 'interval', 'count', 'from'].includes(key))) return null;
  const from = Number(params.get('from'));
  const asset = params.get('pool')?.trim().toUpperCase();
  if (!asset || !/^[A-Z0-9]+\./.test(asset) || !integer(params.get('from'))
    || !Number.isSafeInteger(from) || from < 0 || from % DAY !== 0) return null;
  const interval = params.get('interval');
  const count = Number(params.get('count'));
  let duration;
  if (interval === 'day' && params.get('count') === '1') duration = DAY;
  else if (interval === '5min' && integer(params.get('count')) && Number.isSafeInteger(count)
    && count > 0 && count < DAY / 300 && count * 300 % PREFIX_SECONDS === 0) duration = count * 300;
  else return null;
  const to = from + duration;
  if (!Number.isFinite(new Date(to * 1000).getTime())) return null;
  return { asset, from, to, interval, day: new Date(from * 1000).toISOString().slice(0, 10) };
}

/** Reuse the exact, watermark-verified pool history already owned by Pool
 * Analysis. A cached subset never replaces discovery of the day's pool
 * universe; the caller still asks for every earnings/actions-discovered pool.
 * Intraday rows are UTC-day prefixes, not individual five-minute intervals.
 * A midnight row belongs to the new day and cannot represent yesterday.
 * Cache misses use the same globally budgeted provider as every other step. */
export function createFinancialDaySource({ client, getJson }) {
  return async route => {
    const window = poolRequest(route);
    if (!window) return getJson(route);
    const completed = window.interval === 'day';
    const { rows } = completed ? await client.query(`select asset, day::text, volume_rune_e8::text, volume_usd_e2::text,
        interval_start, interval_end, partial, source, completed_at
      from pool_analysis_daily where asset = $1 and day = $2::date`, [window.asset, window.day])
      : await client.query(`select asset, bucket_end, volume_rune_e8::text, volume_usd_e2::text, observed_at
      from pool_analysis_intraday_snapshots where asset = $1 and bucket_end = $2`,
      [window.asset, new Date(window.to * 1000).toISOString()]);
    const row = rows.length === 1 ? rows[0] : null;
    const verified = row && (completed
      ? row.day === window.day && row.partial === false && row.source === 'liquify-midgard-swaps'
        && timestamp(row.completed_at) >= window.to * 1000
        && timestamp(row.interval_start) === window.from * 1000
        && timestamp(row.interval_end) === window.to * 1000
      : timestamp(row.bucket_end) === window.to * 1000 && timestamp(row.observed_at) >= window.to * 1000);
    const metric = completed ? 'financials-pool-day' : 'financials-pool-prefix';
    if (verified && row.asset === window.asset
      && integer(row.volume_rune_e8) && integer(row.volume_usd_e2)) {
      recordAcquisitionMetric(metric, 'hit');
      return { intervals: [{ startTime: String(window.from), endTime: String(window.to),
        totalVolume: row.volume_rune_e8, totalVolumeUSD: row.volume_usd_e2 }] };
    }
    recordAcquisitionMetric(metric, 'miss');
    return getJson(route);
  };
}
