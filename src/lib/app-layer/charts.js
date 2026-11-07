import { appLayerChartRange } from './chart-range.js';
import { TERMINAL_CHART_PALETTE } from '../charts/terminal.js';
import { denomLabel, fillBucketGaps, formatWeekLabel } from './model.js';

import { buildAccruedValueTooltipDetails, buildPolAccrualTooltipDetails } from './chart-tooltips.js';
import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { utcDayWindow } from '../charts/viewport.js';
import { buildSummaryCards, selectSummaryRows } from '../charts/summary.js';
import { reduceObservations } from '../charts/analytics.js';
import { generatedFeeCoverage, normalizeGeneratedFeeHistory } from './fee-pricing.js';

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
      Number.isFinite(row.liquidity_fee_rune)
        ? `${number4.format(row.liquidity_fee_rune)} ${row.fee_coverage_unknown ? 'observed ' : ''}RUNE fees` : 'RUNE fees unavailable',
      ...(row.rune_price_usd > 0 ? [`${number4.format(row.rune_price_usd)} RUNE/USD`] : []),
      Number.isFinite(row.cumulative_rune) && !row.history_incomplete
        ? `${number4.format(row.cumulative_rune)} cumulative RUNE` : 'Cumulative RUNE unavailable'
    ]
  }
});

// Collector/settlement records keep their existing empty-activity policy. Fee
// history has independent capture/pricing coverage: an absent bucket is unknown.
export function prepareAppLayerChart(pick, key) {
  const config = APP_LAYER_CHARTS[key];
  const step = pick.grain === 'weekly' ? 7 : 1;
  const input = key === 'generated' ? normalizeGeneratedFeeHistory(pick.rows, step) : pick.rows;
  const trackFeeCoverage = key === 'generated' || key === 'accrued' && input.some(row => row.fee_coverage_tracked);
  const observed = new Set(input.map(row => row.bucket_start));
  let cumulativeMissing = false;
  return fillBucketGaps(input, config.valueField, config.cumulativeField, step).map(row => {
    const filledBucket = !observed.has(row.bucket_start);
    const missingFee = trackFeeCoverage && (filledBucket || row.liquidity_fee_usd === null);
    cumulativeMissing ||= missingFee || trackFeeCoverage && row[config.cumulativeField] === null;
    return {
      ...row, day: row.bucket_start, filledBucket,
      ...(trackFeeCoverage && filledBucket ? {
        fee_coverage_tracked: true, fee_coverage_unknown: true,
        liquidity_fee_usd: null, [config.valueField]: null
      } : {}),
      ...(cumulativeMissing ? { [config.cumulativeField]: null } : {})
    };
  });
}

function chartValue(row, field, key) {
  const value = row[field];
  if (Number.isFinite(value)) return value;
  return value === null || key === 'generated' || key === 'accrued' && row.fee_coverage_tracked && field !== 'inflow_usd' ? null : 0;
}

export function appLayerSummaryMetrics(key) {
  const labels = { accrued: 'Accrued value', collected: 'Retained earnings', paid: 'Payments', pol: 'POL accrued', generated: 'Liquidity fees' };
  const fields = key === 'accrued'
    ? [{ field: 'inflow_usd', label: 'Retained earnings' }, { field: 'liquidity_fee_usd', label: 'Liquidity fees' }]
    : [{ field: APP_LAYER_CHARTS[key].valueField, label: labels[key] }];
  return fields.map(item => ({ ...item, value: row => chartValue(row, item.field, key), kind: 'flow', unit: 'usd' }));
}

export function appLayerSummary(rows, key, window = null, bucket = 'day') {
  const selected = selectSummaryRows(rows, window);
  const coverage = generatedFeeCoverage(selected);
  const cards = buildSummaryCards(selected, appLayerSummaryMetrics(key), bucket).map((card, index) => ({
    ...card,
    unavailableLabel: coverage.unpricedEvents && (key === 'generated' || key === 'accrued' && index >= 2) ? 'Unpriced' : 'Unavailable'
  }));
  const feeNote = [
    ...(coverage.unpricedEvents ? [`${number4.format(coverage.unpricedRune)} RUNE in ${number2.format(coverage.unpricedEvents)} fee events is unpriced; ${usd2.format(coverage.pricedUsd)} is the known USD subtotal.`] : []),
    ...(coverage.unknownBuckets ? [`${coverage.unknownBuckets} ${bucket} buckets have unknown fee coverage.`] : []),
    'Unpriced fees and unknown fee buckets are excluded from USD statistics; they are not zero.'
  ].join(' ');
  return { cards, note: key === 'generated' || key === 'accrued' && rows.some(row => row.fee_coverage_tracked)
    ? feeNote : 'Periodic values, including known empty activity buckets; never sums of the cumulative line.' };
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
    `${row.day} · ${grain === 'weekly' || grain === 'week' ? 'WEEK' : grain === 'month' ? 'MONTH' : 'DAY'} (UTC)`,
    ...appLayerSeries(key, view).filter(item => !hidden.includes(item.id)).map(item => ({
      id: item.id, color: item.colors.mark, fill: view === 'bars' ? item.colors.fill : item.colors.faint,
      text: `${item.label}: ${Number.isFinite(chartValue(row, item.valueField, key)) ? usd2.format(chartValue(row, item.valueField, key))
        : (view === 'cumulative' ? row.cumulative_unpriced_events : row.unpriced_events) > 0 ? 'Unpriced' : 'Unavailable'}`
    })),
    ...(config.details?.(row, grain) || []),
    ...(row.unpriced_events > 0 ? [`${number4.format(row.unpriced_fee_rune)} RUNE in ${number2.format(row.unpriced_events)} fee events is unpriced`, `${usd2.format(row.priced_fee_usd || 0)} known USD subtotal`] : []),
    ...(view === 'cumulative' && row.cumulative_unpriced_events > 0 ? [`${number4.format(row.cumulative_unpriced_fee_rune)} cumulative RUNE fees are unpriced`] : []),
    ...(row.fee_coverage_unknown ? ['Fee coverage unavailable · not a verified zero']
      : row.filledBucket ? ['Empty activity bucket · cumulative carried forward'] : []),
    ...(view === 'cumulative' && row.history_incomplete ? ['Earlier fee history has unknown coverage'] : [])
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
      data: rows.map(row => chartValue(row, item.valueField, key))
    })),
    tooltip: row => appLayerTooltip(row, { key, view, grain, hidden }),
    groupedTooltip: key === 'generated' || key === 'accrued' ? (row, context) => {
      const selected = context.rows;
      const coverage = generatedFeeCoverage(selected);
      const combined = {
        ...selected.at(-1), day: `${row.fromDay} → ${row.throughDay}`,
        unpriced_events: coverage.unpricedEvents, unpriced_fee_rune: coverage.unpricedRune,
        priced_fee_usd: coverage.pricedUsd, fee_coverage_unknown: coverage.unknownBuckets > 0,
        liquidity_fee_rune: selected.some(point => Number.isFinite(point.liquidity_fee_rune))
          ? selected.reduce((sum, point) => sum + (point.liquidity_fee_rune || 0), 0) : null,
        accrued_value_usd: reduceObservations(selected, selected.map(point => chartValue(point, 'accrued_value_usd', key)), 'sum')
      };
      for (const item of descriptors) combined[item.valueField] = reduceObservations(selected, selected.map(point => chartValue(point, item.valueField, key)), view === 'cumulative' ? 'last' : 'sum');
      return appLayerTooltip(combined, { key, view, grain: context.grain, hidden: context.hidden });
    } : null
  });
}
