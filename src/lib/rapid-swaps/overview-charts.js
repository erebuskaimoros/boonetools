import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { formatNumber, formatUSDCompact } from '../utils/formatting.js';
import { getSeriesAxisBounds } from './charts.js';
import { RAPID_SWAP_CHART_COLORS as colors } from './colors.js';

const countFormat = (value) => formatNumber(value, { maximumFractionDigits: 0 });
const percentFormat = (value) => `${value}%`;
const metrics = {
  volume: { label: 'VOLUME', color: colors.green, fill: colors.greenAlpha, cumulative: 'cumVolume', format: formatUSDCompact },
  count: { label: 'COUNT', color: colors.blue, fill: colors.blueAlpha, cumulative: 'cumCount', format: countFormat },
  efficiency: { label: 'EFFICIENCY', color: colors.green, fill: colors.greenAlpha, mark: 'line', format: (value) => formatNumber(value, { maximumFractionDigits: 2 }), baseline: 'auto' },
  pctFaster: { label: '% FASTER', color: colors.amber, fill: colors.amberAlpha, mark: 'line', format: percentFormat, baseline: 'auto' },
  volumePct: { label: '% OF TC VOLUME', color: colors.yellow, fill: colors.yellowAlpha, format: percentFormat },
  countPct: { label: '% OF TC SWAPS', color: colors.red, fill: colors.redAlpha, format: percentFormat }
};

// Keep legacy local-day identities and seeded totals; calendar aggregation
// groups those source dates without pretending they were UTC-day observations.
export function rapidSwapOverviewPoints(dailyData) {
  return dailyData.days.map((day, index) => ({
    day, label: dailyData.labels[index], calendar: dailyData.calendar,
    ...Object.fromEntries(['volume', 'cumVolume', 'count', 'cumCount', 'efficiency', 'pctFaster', 'volumePct', 'countPct']
      .map((key) => [key, dailyData[key][index]]))
  }));
}

export function rapidSwapOverviewSeries(metric) {
  const config = metrics[metric];
  return [
    { id: metric, label: config.label, color: config.color, mark: config.mark || 'bar' },
    ...(config.cumulative ? [{ id: config.cumulative, label: 'CUMULATIVE', color: colors.amber, mark: 'line' }] : [])
  ];
}

export function rapidSwapOverviewTooltip(row, { metric = 'volume', hidden = [] } = {}) {
  const config = metrics[metric];
  return timeSeriesTooltip([
    `${row.day} · ${row.calendar === 'UTC' ? 'UTC' : 'LOCAL DAY'}`,
    ...rapidSwapOverviewSeries(metric).filter((item) => !hidden.includes(item.id)).map((item) => ({
      ...item, text: `${item.label}: ${Number.isFinite(row[item.id]) ? config.format(row[item.id]) : 'unavailable'}`
    }))
  ]);
}

export function buildRapidSwapOverviewOption(rows, { metric = 'volume', hidden = [], width = 1000, analysis = null } = {}) {
  const config = metrics[metric];
  const descriptors = rapidSwapOverviewSeries(metric);
  return buildTimeSeriesOption(rows, {
    width, hidden, analysis, calendar: rows[0]?.calendar === 'UTC' ? 'UTC' : 'LOCAL DAY', zoom: false, compact: true,
    xLabel: (day) => rows.find((row) => row.day === day)?.label || day,
    tooltip: (row) => rapidSwapOverviewTooltip(row, { metric, hidden }),
    axes: descriptors.map((item, index) => ({
      id: item.id, label: item.label, color: item.color, position: index ? 'right' : 'left',
      format: config.format, baseline: config.baseline,
      integer: metric === 'count',
      ...(index ? getSeriesAxisBounds(rows.map((row) => row[item.id]), {
        clampMin: 0, minSpan: 1, roundToInteger: metric === 'count'
      }) : {})
    })),
    series: descriptors.map((item, index) => ({
      ...item, aggregate: index ? 'last' : ['volume', 'count'].includes(metric) ? 'sum' : 'mean', axis: item.id, data: rows.map((row) => row[item.id]),
      fill: index ? undefined : config.fill,
      areaFill: config.mark === 'line' ? config.fill : undefined,
      smooth: config.mark === 'line' ? 0.3 : false,
      symbolSize: item.mark === 'line' ? config.mark === 'line' ? 8 : 6 : 0
    }))
  });
}
