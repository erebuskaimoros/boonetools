import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';
import { buildTimeSeriesOption, timeSeriesTooltip, utcDayLabel } from '../charts/time-series.js';
import { poolAnalysisFeeVolumeBps, poolAnalysisLineMetric } from './model.js';
import { POOL_ROLLING_AVERAGES, buildPoolRollingAverages, mergePoolRollingHistory } from './rolling-averages.js';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const rune = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const amount = (value) => value == null ? 'unavailable' : usd.format(value);

export function poolAnalysisChartSeries(lineMetricId = 'cumulativeFees') {
  const lineMetric = poolAnalysisLineMetric(lineMetricId);
  return [
    { id: 'volume', label: 'DAILY VOLUME', mark: 'bar', color: palette.info, fill: 'rgba(85,136,204,0.30)', field: 'volumeUsd' },
    { id: 'fees', label: 'DAILY FEES', mark: 'bar', color: palette.amber, fill: 'rgba(212,160,23,0.28)', field: 'feesUsd' },
    { id: 'line', label: lineMetric.label, mark: 'line', color: palette.accent, field: lineMetric.field }
  ];
}

export function poolAnalysisTooltip(row, lineMetricId = 'cumulativeFees', hidden = [], averages = [], rollingValues = {}) {
  const lineMetric = poolAnalysisLineMetric(lineMetricId);
  const feeVolumeBps = poolAnalysisFeeVolumeBps(row.feesRuneBase, row.volumeRuneBase);
  const bps = feeVolumeBps === null ? 'unavailable' : `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Math.abs(feeVolumeBps) < 10 && feeVolumeBps !== 0 ? 2 : 0
  }).format(feeVolumeBps)} BPS`;
  return timeSeriesTooltip([
    `${utcDayLabel(row.day)} · UTC`,
    ...poolAnalysisChartSeries(lineMetricId).filter(series => !hidden.includes(series.id))
      .map((series) => ({ ...series, text: `${series.label}: ${amount(row[series.field])}` })),
    ...averages.map((series) => ({ ...series,
      text: `${series.label}: ${amount(rollingValues[series.id]?.value)}${rollingValues[series.id]?.partial ? ' · PARTIAL WINDOW' : ''}` })),
    `FEES / VOLUME: ${bps}`,
    `FEES IN RUNE: ${row.feesRune == null ? 'unavailable' : `${rune.format(row.feesRune)} ᚱ`}`,
    ...(row.partial || lineMetric.id === 'depth' && row.depthPartial ? ['LIVE PARTIAL UTC DAY'] : []),
    ...(lineMetric.id === 'depth' && row.depthPartial && row.depthUpdatedAt ? [`DEPTH OBSERVED: ${row.depthUpdatedAt}`] : []),
    ...(row.source === 'missing' ? ['MISSING SOURCE DAY'] : [])
  ]);
}

export function buildPoolAnalysisOption(rows, { lineMetric = 'cumulativeFees', hidden = [], rollingAverages = [], rollingHistory = [], ...viewport } = {}) {
  const series = poolAnalysisChartSeries(lineMetric);
  const averages = POOL_ROLLING_AVERAGES.filter((item) => rollingAverages.includes(item.id));
  const rollingValues = averages.length ? buildPoolRollingAverages(mergePoolRollingHistory(rollingHistory, rows), rollingAverages) : new Map();
  // Bars and averages toggle independently, but share their metric's USD axis.
  const hiddenAxes = hidden.filter((id) => !averages.some((item) => item.axis === id));
  return buildTimeSeriesOption(rows, {
    ...viewport, hidden: hiddenAxes,
    axes: series.map((item, index) => ({ ...item, label: `${item.label} · USD`,
      position: index === 0 ? 'left' : 'right', baseline: index === 2 ? 'auto' : 'zero',
      format: (value) => value == null ? '—' : compact.format(value) })),
    series: [
      ...series.map((item) => ({ ...item, aggregate: item.id === 'line' ? 'last' : 'sum', axis: item.id, smooth: 0.08, data: hidden.includes(item.id) ? [] : rows.map((row) => row[item.field]) })),
      ...averages.map((item) => ({ ...item, data: rows.map((row) => rollingValues.get(row.day)?.[item.id]?.value ?? null) }))
    ],
    tooltip: (row) => poolAnalysisTooltip(row, lineMetric, hidden, averages, rollingValues.get(row.day))
  });
}
