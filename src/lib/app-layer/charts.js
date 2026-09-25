import { appLayerChartRange } from './chart-range.js';
import { TERMINAL_CHART_PALETTE } from '../charts/terminal.js';
import { denomLabel, fillBucketGaps, formatWeekLabel } from './model.js';

import { buildAccruedValueTooltipDetails, buildPolAccrualTooltipDetails } from './chart-tooltips.js';
import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { utcDayWindow } from '../charts/viewport.js';

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});
const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});
const signedUsd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  signDisplay: 'always'
});
const number2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const signedNumber4 = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
  signDisplay: 'always'
});

export const APP_LAYER_SERIES = Object.freeze({
  accrued: {
    mark: '#00cc66',
    fill: 'rgba(0, 204, 102, 0.5)',
    faint: 'rgba(0, 204, 102, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.accent
  },
  collected: {
    mark: '#b8860b',
    fill: 'rgba(184, 134, 11, 0.5)',
    faint: 'rgba(184, 134, 11, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.amber
  },
  paid: {
    mark: '#00a755',
    fill: 'rgba(0, 167, 85, 0.5)',
    faint: 'rgba(0, 167, 85, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.accent
  },
  pol: {
    mark: '#d4a017',
    fill: 'rgba(212, 160, 23, 0.5)',
    faint: 'rgba(212, 160, 23, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.amber
  },
  generated: {
    mark: '#2f7fd6',
    fill: 'rgba(47, 127, 214, 0.5)',
    faint: 'rgba(47, 127, 214, 0.09)',
    chrome: '#44a0ff'
  }
});

export function collectedFlowTooltip(row, grain, limit = 4) {
  const entries = Object.entries(row.by_denom || {}).sort(
    (left, right) => Math.abs(right[1].usd || 0) - Math.abs(left[1].usd || 0)
  );
  const shown = entries.slice(0, limit);
  const remaining = entries.slice(limit);
  const lines = [
    `${number2.format(row.transfers || 0)} ${grain === 'weekly' ? 'denom-day' : 'denom'} balance changes`,
    ...shown.map(
      ([denom, entry]) =>
        `${denomLabel(denom)}: ${signedNumber4.format(entry.amount)} · ${signedUsd2.format(entry.usd)}`
    )
  ];
  if (remaining.length) {
    const remainingUsd = remaining.reduce((sum, [, entry]) => sum + (entry.usd || 0), 0);
    lines.push(`${number2.format(remaining.length)} other net: ${signedUsd2.format(remainingUsd)}`);
  }
  return lines;
}

const number4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

export const APP_LAYER_CHARTS = Object.freeze({
  accrued: {
    valueField: 'accrued_value_usd', cumulativeField: 'cumulative_usd',
    barLabel: 'TC-retained accrued value (01 + 03)',
    cumulativeLabel: 'Cumulative TC-retained value (01 + 03)',
    parts: [
      { id: 'retained', label: '01 · Base Layer earnings (TC-retained share)', valueField: 'inflow_usd', colors: APP_LAYER_SERIES.collected },
      { id: 'liquidity', label: '03 · TC liquidity fees generated', valueField: 'liquidity_fee_usd', colors: APP_LAYER_SERIES.generated }
    ],
    details: buildAccruedValueTooltipDetails
  },
  collected: {
    valueField: 'inflow_usd', cumulativeField: 'cumulative_usd',
    barLabel: 'App-layer earnings retained for TC (2/3 since cutover)',
    cumulativeLabel: 'Cumulative app-layer earnings retained for TC',
    details: collectedFlowTooltip
  },
  paid: {
    valueField: 'payment_usd', cumulativeField: 'cumulative_usd',
    barLabel: 'TC Reserve settlement USD', cumulativeLabel: 'Cumulative TC Reserve settlement USD',
    details: row => [
      `${number2.format(row.payments || 0)} Reserve deposit${row.payments === 1 ? '' : 's'}`,
      `${number2.format(row.payment_rune || 0)} RUNE to Reserve`,
      `${number4.format(row.rune_price_usd || row.settlement_rune_price_usd || 0)} avg historical RUNE/USD`,
      `${number2.format(row.cumulative_rune || 0)} cumulative Reserve RUNE`
    ]
  },
  pol: {
    valueField: 'pol_accrued_usd', cumulativeField: 'cumulative_pol_accrued_usd',
    barLabel: 'THORChain POL accrual USD', cumulativeLabel: 'Cumulative THORChain POL accrual USD',
    details: buildPolAccrualTooltipDetails
  },
  generated: {
    valueField: 'liquidity_fee_usd', cumulativeField: 'cumulative_usd',
    barLabel: 'Generated fees USD', cumulativeLabel: 'Cumulative generated fees USD',
    details: row => [
      `${number4.format(row.liquidity_fee_rune || 0)} RUNE fees`,
      `${number4.format(row.rune_price_usd || 0)} RUNE/USD`,
      `${number4.format(row.cumulative_rune || 0)} cumulative RUNE`
    ]
  }
});

// App Layer's existing activity-bucket policy belongs here, not in the host:
// absent activity buckets are zero, and their all-history totals carry forward.
export function prepareAppLayerChart(pick, key) {
  const config = APP_LAYER_CHARTS[key];
  const observed = new Set(pick.rows.map(row => row.bucket_start));
  return fillBucketGaps(pick.rows, config.valueField, config.cumulativeField, pick.grain === 'weekly' ? 7 : 1)
    .map(row => ({ ...row, day: row.bucket_start, filledBucket: !observed.has(row.bucket_start) }));
}

export function appLayerSummaryMetrics(key) {
  const labels = { accrued: 'Accrued value', collected: 'Retained earnings', paid: 'Payments', pol: 'POL accrued', generated: 'Liquidity fees' };
  const fields = key === 'accrued'
    ? [{ field: 'inflow_usd', label: 'Retained earnings' }, { field: 'liquidity_fee_usd', label: 'Liquidity fees' }]
    : [{ field: APP_LAYER_CHARTS[key].valueField, label: labels[key] }];
  // This feature explicitly fills empty activity buckets with zero, as in its bars.
  return fields.map(item => ({ ...item, value: row => row[item.field] || 0, kind: 'flow', unit: 'usd' }));
}

export function appLayerPresetWindow(rows, range = '30d', grain = 'daily') {
  const bounds = appLayerChartRange(rows, range === 'all' ? null : 30, grain);
  return bounds.min == null ? null : utcDayWindow(rows, bounds.min, bounds.max);
}

export function appLayerSeries(key, view = 'bars') {
  const config = APP_LAYER_CHARTS[key];
  const colors = APP_LAYER_SERIES[key];
  return view === 'cumulative'
    ? [{ id: key, label: config.cumulativeLabel, valueField: config.cumulativeField, colors, mark: 'line' }]
    : (config.parts || [{ id: key, label: config.barLabel, valueField: config.valueField, colors }])
      .map(item => ({ ...item, mark: 'bar' }));
}

export function appLayerTooltip(row, { key, view = 'bars', grain = 'daily', hidden = [] }) {
  const config = APP_LAYER_CHARTS[key];
  return timeSeriesTooltip([
    `${row.day} · ${grain === 'weekly' ? 'WEEK START' : 'DAY'} (UTC)`,
    ...appLayerSeries(key, view).filter(item => !hidden.includes(item.id)).map(item => ({
      id: item.id, color: item.colors.mark, fill: view === 'bars' ? item.colors.fill : item.colors.faint,
      text: `${item.label}: ${usd2.format(row[item.valueField] || 0)}`
    })),
    ...(config.details?.(row, grain) || []),
    ...(row.filledBucket ? ['Empty activity bucket · cumulative carried forward'] : [])
  ]);
}

export function buildAppLayerOption(rows, { key = 'accrued', view = 'bars', grain = 'daily', hidden = [], window = null, width = 1000, analysis = null } = {}) {
  const colors = APP_LAYER_SERIES[key];
  const descriptors = appLayerSeries(key, view);
  return buildTimeSeriesOption(rows, {
    window, width, hidden, analysis, sourceGrain: grain === 'weekly' ? 'week' : 'day', xLabel: formatWeekLabel,
    axes: [{ id: 'value', label: 'USD', position: 'left', color: colors.chrome,
      baseline: view === 'cumulative' ? 'auto' : 'signed',
      format: value => Math.abs(value) >= 1000 ? usd0.format(value) : usd2.format(value) }],
    series: descriptors.map(item => ({
      id: item.id, label: item.label, aggregate: view === 'cumulative' ? 'last' : 'sum', mark: item.mark, axis: 'value',
      color: item.colors.mark, fill: item.colors.fill,
      stack: view === 'bars' && descriptors.length > 1 ? 'app-value' : undefined,
      areaFill: view === 'cumulative' ? item.colors.faint : undefined,
      symbolSize: view === 'cumulative' && rows.length <= 45 ? 5 : 0,
      data: rows.map(row => row[item.valueField] || 0)
    })),
    tooltip: row => appLayerTooltip(row, { key, view, grain, hidden })
  });
}
