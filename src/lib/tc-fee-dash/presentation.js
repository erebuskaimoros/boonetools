import { formatNumber, formatUSD } from '../utils/formatting.js';

export function formatTcFeeUsdCompact(value) {
  const numeric = Number(value) || 0;
  if (Math.abs(numeric) >= 1_000_000_000_000) {
    return `$${formatNumber(numeric / 1_000_000_000_000, { maximumFractionDigits: 2 })}T`;
  }
  if (Math.abs(numeric) >= 1_000_000_000) {
    return `$${formatNumber(numeric / 1_000_000_000, { maximumFractionDigits: 2 })}B`;
  }
  return formatUSD(numeric);
}

export function formatTcFeeBps(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${formatNumber(numeric, { maximumFractionDigits: 2 })} bps`;
}

export function formatTcFeeDate(value) {
  if (!value) return '--';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

export function tcFeePointColor(rowOrValue) {
  if (rowOrValue?.hasHaltDays || rowOrValue?.rollingAverageExcluded) return '#d4a017';
  const value = typeof rowOrValue === 'object' ? rowOrValue.feeBps : rowOrValue;
  if (value >= 20) return '#d4a017';
  if (value >= 15) return '#00cc66';
  if (value >= 10) return '#5588cc';
  if (value >= 5) return '#888888';
  return '#dc3545';
}
