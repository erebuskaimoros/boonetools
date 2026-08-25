import { applyBurnTrackerLiveOverlay } from '../../../shared/burn-tracker/model.js';

export const BURN_TRACKER_RANGES = Object.freeze([
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '180d', label: '180D', days: 180 },
  { id: 'all', label: 'ALL TIME', days: null }
]);

function day(value) {
  const normalized = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function baseString(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function baseToRuneNumber(value) {
  const normalized = baseString(value);
  return normalized === null ? null : Number(normalized) / 1e8;
}

export function normalizeBurnTrackerPayload(payload = {}) {
  const daily = (Array.isArray(payload.daily) ? payload.daily : [])
    .map((row) => ({
      day: day(row.day),
      burnedBase: baseString(row.burn_e8),
      burnedRune: baseToRuneNumber(row.burn_e8),
      cumulativeBurnedBase: baseString(row.cumulative_burn_e8),
      cumulativeBurnedRune: baseToRuneNumber(row.cumulative_burn_e8),
      runePriceUsd: finite(row.rune_price_usd),
      partial: Boolean(row.partial),
      source: String(row.source || '')
    }))
    .filter((row) => row.day)
    .sort((left, right) => left.day.localeCompare(right.day));
  let cumulativeBurnedUsd = 0;
  let cumulativeUsdComplete = true;
  for (const row of daily) {
    row.burnedUsd = row.burnedRune === null
      ? null
      : row.burnedRune === 0
        ? 0
        : row.runePriceUsd === null
          ? null
          : row.burnedRune * row.runePriceUsd;
    if (row.burnedUsd === null) cumulativeUsdComplete = false;
    else cumulativeBurnedUsd += row.burnedUsd;
    row.cumulativeBurnedUsd = cumulativeUsdComplete ? cumulativeBurnedUsd : null;
  }
  return {
    asOf: payload.as_of || null,
    stale: Boolean(payload.stale),
    totalBurnedBase: baseString(payload.summary?.total_burned_e8),
    currentSupplyBase: baseString(payload.summary?.current_supply_e8),
    burnRateBps: finite(payload.summary?.burn_rate_bps),
    burnRatePercent: finite(payload.summary?.burn_rate_percent),
    daily,
    coverage: payload.coverage && typeof payload.coverage === 'object' ? payload.coverage : {},
    sources: payload.sources && typeof payload.sources === 'object' ? payload.sources : {},
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    perBlock: Boolean(payload.live?.per_block),
    liveHeight: Math.max(0, Math.trunc(Number(payload.live?.through_height)) || 0),
    liveTime: payload.live?.through_time || null
  };
}

export function applyBurnTrackerHeadPayload(payload, head = {}) {
  const height = Math.max(0, Math.trunc(Number(head.height)) || 0);
  const currentHeight = Math.max(0, Math.trunc(Number(payload?.live?.through_height)) || 0);
  const timestamp = Date.parse(String(head.time || ''));
  if (height <= currentHeight || !Number.isFinite(timestamp)) return payload;
  const burn = baseString(head.income_burn_e8);
  return applyBurnTrackerLiveOverlay(payload || {}, {
    days: burn === null ? [] : [{
      day: new Date(timestamp).toISOString().slice(0, 10),
      burn_e8: burn
    }],
    through_height: height,
    through_time: new Date(timestamp).toISOString()
  });
}

export function selectBurnTrackerRange(rows = [], rangeId = '90d') {
  const ordered = Array.isArray(rows) ? rows : [];
  const range = BURN_TRACKER_RANGES.find((candidate) => candidate.id === rangeId)
    || BURN_TRACKER_RANGES[1];
  if (!range.days || ordered.length <= range.days) return ordered;
  return ordered.slice(-range.days);
}

export function formatBurnTrackerRuneBase(value, options = {}) {
  const rune = baseToRuneNumber(value);
  if (rune === null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: options.compact ? 'compact' : 'standard',
    minimumFractionDigits: options.compact ? 0 : 2,
    maximumFractionDigits: options.compact ? 2 : 2
  }).format(rune);
}

export function formatBurnTrackerRate(value) {
  const rate = finite(value);
  return rate === null ? '—' : `${rate.toFixed(2)}%`;
}

export function formatBurnTrackerPrice(value) {
  const price = finite(value);
  return price === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4
      }).format(price);
}
