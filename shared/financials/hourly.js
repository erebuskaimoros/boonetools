import { integerAmount } from './model.js';

export const HOUR_SECONDS = 3600;
export const FINANCIALS_HOURLY_RANGES = Object.freeze([
  { id: '24h', label: '24H', hours: 24 },
  { id: '7d', label: '7D', hours: 168 },
  { id: '30d', label: '30D', hours: 720 }
]);
export const FINANCIALS_HOURLY_MODEL_KEY = 'financials:hour:30d:v1';

// Rolling UTC clock-hour buckets, including the current (partial) hour.
export function financialHourlyWindow(range = '24h', now = Date.now()) {
  const hours = FINANCIALS_HOURLY_RANGES.find(item => item.id === range)?.hours;
  if (!hours) throw new Error('Hourly range must be 24h, 7d, or 30d');
  const to = Math.floor(now / 1000 / HOUR_SECONDS) * HOUR_SECONDS + HOUR_SECONDS;
  return { from: to - hours * HOUR_SECONDS, to };
}

const amount = (value, scale = 1e8) => integerAmount(value) === null ? null : Number(value) / scale;
const price = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function financialHourlyPoint(start, swap, income, through = start + HOUR_SECONDS) {
  const incomeRune = amount(income?.earnings), runePriceUsd = price(income?.runePriceUSD);
  return {
    // Explicit category adapter: preserve the full ISO timestamp as the chart
    // key. No daily calendar reduction or daily rolling math is used for hours.
    day: new Date(start * 1000).toISOString(), start, through,
    partial: through < start + HOUR_SECONDS,
    volumeRune: amount(swap?.totalVolume), volumeUsd: amount(swap?.totalVolumeUSD, 100),
    incomeRune, incomeUsd: incomeRune === null || runePriceUsd === null ? null : incomeRune * runePriceUsd,
    feesRune: amount(income?.liquidityFees), runePriceUsd
  };
}

// Read-only ageing never promotes an unfinished hour into completed history.
export function sliceFinancialHourlyPayload(payload, range = '24h', now = Date.now()) {
  const { from, to } = financialHourlyWindow(range, now);
  const saved = new Map((payload?.points || []).map(point => [point.start, point]));
  const current = to - HOUR_SECONDS, points = [];
  for (let start = from; start < to; start += HOUR_SECONDS) {
    const point = saved.get(start);
    points.push(point && (!point.partial || start === current) ? point
      : financialHourlyPoint(start, null, null, start === current ? start : start + HOUR_SECONDS));
  }
  const through = payload?.live?.through;
  const stale = Boolean(payload?.stale || !through || now - Date.parse(through) > 600_000);
  return { ...payload, bucket: 'hour', range, points, stale,
    live: { ...payload?.live, through: through || null, stale }, bonding: { pending: 0, days: 0 } };
}

export function formatFinancialHour(value) {
  return value ? new Date(value).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC'
  }) : '—';
}
