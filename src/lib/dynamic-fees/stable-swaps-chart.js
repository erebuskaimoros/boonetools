import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';
import { buildTimeSeriesOption, timeSeriesTooltip, utcDayLabel } from '../charts/time-series.js';
import { weightedStableSwapFeeBps } from './stable-swaps.js';

export const STABLE_SWAP_SERIES = Object.freeze([
  { id: 'volume', label: 'VOLUME', mark: 'bar', color: palette.info },
  { id: 'fees', label: 'FEES', mark: 'bar', color: palette.amber },
  { id: 'feeBps', label: 'EFFECTIVE FEE (BPS)', mark: 'line', color: palette.accent }
]);
export const STABLE_SWAP_DEFAULT_HIDDEN = Object.freeze(['feeBps']);

const volumeFill = (row) => row?.partial ? 'rgba(85,136,204,0.16)' : 'rgba(85,136,204,0.34)';
const feesFill = (row) => row?.partial ? 'rgba(212,160,23,0.16)' : 'rgba(212,160,23,0.34)';
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const rune = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const formatStableUsd = (value) => Number.isFinite(value) ? usd.format(value) : 'unavailable';
export const formatStableBps = (value) => Number.isFinite(value) ? `${value.toFixed(2)} bps` : 'unavailable';
const formatRune = (value) => Number.isFinite(value) ? `${rune.format(value)} ᚱ` : 'unavailable';

function compactUsd(value) {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (absolute >= 1_000) return `$${(value / 1_000).toFixed(absolute < 10_000 ? 2 : 1)}k`;
  return `$${value.toFixed(absolute < 10 ? 2 : 0)}`;
}

/**
 * Feature-owned weighted reducer for calendar buckets and rolling windows:
 * sum(fees) / sum(volume), never a mean of daily rates.
 */
export const stableSwapWeightedBpsReducer = (sample) => weightedStableSwapFeeBps(sample);

const sumField = (rows, field) => {
  const values = rows.map((row) => row[field]).filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
};

/**
 * Observed fee flow for a W/M bucket: sum of days with known USD fees, null only
 * when none are known. Unpriced days are disclosed in the grouped tooltip.
 * Rolling averages keep the foundation's daily mean (rollingReduce is separate).
 */
export const stableSwapObservedFeesReducer = (sample) => sumField(sample, 'feesUsd');

function metricLines(values, hidden, row) {
  return STABLE_SWAP_SERIES.flatMap((series, index) => hidden.includes(series.id) ? [] : [{
    ...series, fill: index === 0 ? volumeFill(row) : index === 1 ? feesFill(row) : series.color,
    text: `${series.label}: ${index === 2 ? formatStableBps(values[index]) : formatStableUsd(values[index])}`
  }]);
}

export function stableSwapsTooltip(row, { hidden = [...STABLE_SWAP_DEFAULT_HIDDEN] } = {}) {
  return timeSeriesTooltip([
    `${utcDayLabel(row.day)} · UTC`,
    `SWAPS: ${Number.isFinite(row.swaps) ? count.format(row.swaps) : 'unavailable'}`,
    ...metricLines([row.volumeUsd, row.feesUsd, row.feeBps], hidden, row),
    `FEES (RUNE): ${formatRune(row.feesRune)}`,
    ...(row.partial ? ['LIVE PARTIAL UTC DAY'] : [])
  ]);
}

// Weekly/monthly hover detail recomputed from the source days in the bucket.
export function stableSwapsGroupedTooltip(bucket, { rows = [], grain = 'week', hidden = [] } = {}) {
  const partial = bucket.partial || rows.some((row) => row.partial);
  // Match the plotted buckets: strict volume sum, observed fee sum.
  const strictSum = (field) => rows.every((row) => Number.isFinite(row[field])) ? sumField(rows, field) : null;
  const unpriced = rows.filter((row) => !Number.isFinite(row.feesUsd)).length;
  return timeSeriesTooltip([
    `${bucket.fromDay} → ${bucket.throughDay} · UTC ${String(grain).toUpperCase()}${partial ? ' · PARTIAL BUCKET' : ''}`,
    `SWAPS: ${count.format(sumField(rows, 'swaps') ?? 0)}`,
    ...metricLines([strictSum('volumeUsd'), stableSwapObservedFeesReducer(rows), weightedStableSwapFeeBps(rows)],
      hidden, { partial: false }),
    `FEES (RUNE): ${formatRune(sumField(rows, 'feesRune'))}`,
    ...(unpriced ? [`USD FEES MISSING ON ${unpriced}/${rows.length} DAYS · FEES ARE THE OBSERVED SUM · RATE USES PRICED DAYS`] : []),
    'Volume: sum · fees: observed sum · effective fee: sum fees / sum volume.',
    ...(partial ? ['INCLUDES LIVE PARTIAL UTC DAY'] : [])
  ]);
}

export function buildStableSwapsOption(rows, { hidden = [...STABLE_SWAP_DEFAULT_HIDDEN], ...viewport } = {}) {
  return buildTimeSeriesOption(rows, {
    ...viewport, hidden: [...hidden],
    axes: [
      { ...STABLE_SWAP_SERIES[0], position: 'left', baseline: 'zero', label: 'DAILY VOLUME $',
        format: compactUsd, tooltipFormat: formatStableUsd },
      { ...STABLE_SWAP_SERIES[1], position: 'right', baseline: 'zero', label: 'DAILY FEES $',
        format: compactUsd, tooltipFormat: formatStableUsd },
      { ...STABLE_SWAP_SERIES[2], position: 'right', baseline: 'zero', label: 'FEE BPS',
        format: (value) => Number.isFinite(value) ? value.toFixed(value < 10 ? 1 : 0) : '—', tooltipFormat: formatStableBps }
    ],
    series: [
      { ...STABLE_SWAP_SERIES[0], aggregate: 'sum', axis: 'volume', barMaxWidth: 22,
        fill: (item) => volumeFill(rows[item.dataIndex]), data: rows.map((row) => row.volumeUsd) },
      { ...STABLE_SWAP_SERIES[1], aggregate: stableSwapObservedFeesReducer, axis: 'fees', barMaxWidth: 22,
        fill: (item) => feesFill(rows[item.dataIndex]), data: rows.map((row) => row.feesUsd) },
      { ...STABLE_SWAP_SERIES[2], aggregate: stableSwapWeightedBpsReducer, rollingReduce: stableSwapWeightedBpsReducer,
        axis: 'feeBps', dashed: true, lineWidth: 1.5, smooth: 0.12, data: rows.map((row) => row.feeBps) }
    ],
    tooltip: (row) => stableSwapsTooltip(row, { hidden }),
    groupedTooltip: stableSwapsGroupedTooltip
  });
}
