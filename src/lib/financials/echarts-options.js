import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { DAY_MS, reduceObservations } from '../charts/analytics.js';
import { FINANCIALS_SERIES, financialLineSeries } from './series.js';
import { formatFinancialAmount, formatFinancialDay, formatFinancialPercent } from '../../../shared/financials/model.js';
import { formatLocalDateTime, formatLocalHour, localTimeZone } from '../utils/datetime.js';
import { localHourLabels } from '../charts/hour-labels.js';

export { utcDayZoomWindow as financialEChartsWindow } from '../charts/viewport.js';

const seriesFills = {
  volume: 'rgba(85,136,204,0.30)',
  income: 'rgba(0,204,102,0.35)',
  bondingApr: FINANCIALS_SERIES[2].color
};

// Auto-scaled price windows can have tick spacing smaller than one cent.
const priceAxisFormat = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 8
});

function financialTooltip(row, currency, hidden = [], { header = '', grain = 'day', lineMetric = 'runePriceUsd' } = {}) {
  if (!row) return '';
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const amount = (value, unit = currency, compact = false) => formatFinancialAmount(value, unit, compact);
  const preciseRuneAmount = (value) => value > 0 && value < 0.01
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value)} ᚱ` : amount(value, 'rune');
  const accountingAmount = (value) => Number.isFinite(value) && value >= 0 ? preciseRuneAmount(value) : 'unavailable';
  const adjustment = row.reconciliationAdjustmentRune;
  const signedAdjustment = Number.isFinite(adjustment)
    ? `${adjustment < 0 ? '−' : adjustment > 0 ? '+' : ''}${preciseRuneAmount(Math.abs(adjustment))}` : 'unavailable';
  const grouped = grain !== 'day';
  const metrics = {
    volume: amount(row[`volume${suffix}`]), income: amount(row[`income${suffix}`]),
    bondingApr: formatFinancialPercent(row.bondingApr), runePriceUsd: amount(row.runePriceUsd, 'usd')
  };
  return timeSeriesTooltip([
    header || `${formatFinancialDay(row.day)} · UTC${row.partial ? ' · IN PROGRESS' : ''}`,
    ...[...FINANCIALS_SERIES.slice(0, 2), financialLineSeries(lineMetric)].filter((series) => !hidden.includes(series.id)).map((series) => ({
      ...series, fill: seriesFills[series.id] || series.color,
      text: `${grouped ? series.label.replace(/^DAILY /, grain === 'week' ? 'WEEKLY ' : 'MONTHLY ') : series.label}: ${metrics[series.id]}`
    })),
    '',
    `Gross liquidity fees: ${accountingAmount(row.feesRune)}`,
    `Reserve emissions: ${accountingAmount(row.reserveEmissionsRune)}`,
    `Gross system income: ${accountingAmount(row.grossIncomeRune)}`,
    `REVSHARE: ${Number.isFinite(row.revshareRune) && row.revshareRune > 0 ? '−' : ''}${accountingAmount(row.revshareRune)}`,
    `Reconciliation adjustment: ${signedAdjustment}`,
    `Retained system income: ${accountingAmount(row.incomeRune)}`,
    `Node rewards: ${amount(row.bondingEarningsRune, 'rune')}`,
    `${grouped ? 'Closing active bond' : 'Active bond'}: ${amount(row.activeBondRune, 'rune', true)}`,
    ...(grouped ? ['Flows: sum · RUNE price / active bond: closing observation · APR: mean daily rate.'] : []),
    ...(row.partial && !grouped && Number.isFinite(row.through) ? [
      `Through ${formatLocalDateTime(row.through * 1000)}`,
      'APR: elapsed-time annualized estimate'
    ] : []),
    ...(!Number.isFinite(row.reserveEmissionsRune) || !Number.isFinite(row.revshareRune)
      ? ['Reward breakdown unavailable where verified source coverage is missing.'] : []),
    ...(Number.isFinite(adjustment) && adjustment !== 0 ? ['Adjustment reconciles reported earnings; not emissions or REVSHARE.'] : []),
    ...(row.bondingApr === null ? ['Bonding APR: bond snapshot unavailable'] : []),
    ...(row.incomeUsd === null || row.volumeUsd === null ? ['Some source data is unavailable'] : [])
  ]);
}

export function financialEChartsTooltip(row, currency, hidden = [], lineMetric = 'runePriceUsd') {
  return financialTooltip(row, currency, hidden, { lineMetric });
}

function financialGroupedTooltip(bucket, { rows, grain, hidden }, currency, lineMetric) {
  // Accounting is feature-owned: every periodic flow needs all observed days.
  // Do not disguise missing source values or interior gaps as a smaller total.
  const consecutive = rows.length > 0 && rows.every((row, index) =>
    !index || Date.parse(row.day) - Date.parse(rows[index - 1].day) === DAY_MS);
  const sum = (field) => consecutive ? reduceObservations(rows, rows.map(row =>
    field !== 'reconciliationAdjustmentRune' && row[field] < 0 ? null : row[field]), 'sum') : null;
  const aggregate = { ...bucket,
    ...Object.fromEntries([
      'volumeRune', 'volumeUsd', 'incomeRune', 'incomeUsd', 'feesRune',
      'reserveEmissionsRune', 'revshareRune', 'grossIncomeRune', 'grossIncomeUsd', 'reconciliationAdjustmentRune', 'bondingEarningsRune'
    ].map(field => [field, sum(field)])),
    bondingApr: consecutive ? reduceObservations(rows, rows.map(row => row.bondingApr), 'mean') : null,
    activeBondRune: rows.at(-1)?.activeBondRune ?? null,
    runePriceUsd: rows.at(-1)?.runePriceUsd ?? null
  };
  return financialTooltip(aggregate, currency, hidden, {
    grain, lineMetric,
    header: `${bucket.fromDay} → ${bucket.throughDay} · UTC ${grain.toUpperCase()}${bucket.partial ? ' · PARTIAL BUCKET' : ''}`
  });
}

export function buildFinancialEChartsOption(rows, { currency = 'usd', hidden = [], lineMetric = 'runePriceUsd', ...viewport } = {}) {
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const unit = currency === 'rune' ? 'RUNE' : 'USD';
  const line = financialLineSeries(lineMetric);
  const isApr = line.id === 'bondingApr';
  const metricSeries = [...FINANCIALS_SERIES.slice(0, 2), line];
  // Feature-owned provisional segment: never bridge a missing APR day.
  const partialApr = rows.map((row, index) => (
    row.partial || (rows[index + 1]?.partial && row[line.id] !== null) ? row[line.id] : null
  ));
  return buildTimeSeriesOption(rows, {
    ...viewport, hidden, zoomId: 'financials-window', minSpan: 2,
    axes: metricSeries.map((series, index) => ({
      ...series, position: index === 0 ? 'left' : 'right',
      label: `${index === 0 ? 'VOLUME' : index === 1 ? 'INCOME' : line.label} · ${index === 2 ? isApr ? '%' : 'USD' : unit}`,
      format: index === 2 ? isApr ? formatFinancialPercent : priceAxisFormat.format : (value) => formatFinancialAmount(value, currency)
    })),
    series: [
      ...FINANCIALS_SERIES.slice(0, 2).map((series, index) => ({
        ...series, aggregate: 'sum', axis: series.id, fill: seriesFills[series.id], barMaxWidth: 20, order: 2 - index,
        data: rows.map((row) => row[`${series.id}${suffix}`])
      })),
      { ...line, legend: false, axis: line.id, aggregate: isApr ? 'mean' : 'last', aggregateData: rows.map(row => row[line.id]), rollingData: rows.map(row => row[line.id]), data: rows.map((row) => row.partial ? null : row[line.id]) },
      { ...line, id: `${line.id}-partial`, visibilityId: line.id, axis: line.id,
        label: `${line.label} · IN PROGRESS`, legend: false, rolling: false, data: partialApr, dashed: true,
        symbolSize: (_value, item) => rows[item.dataIndex]?.partial ? 8 : 0 }
    ],
    rollingSeries: [{ ...line, axis: line.id, data: rows.map(row => row[line.id]) }],
    tooltip: (row) => financialEChartsTooltip(row, currency, hidden, lineMetric),
    groupedTooltip: (bucket, context) => financialGroupedTooltip(bucket, context, currency, lineMetric),
    xLabel: (day, index) => rows[index]?.partial ? 'Today*' : new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short', ...(rows.length <= 365 ? { day: 'numeric' } : { year: '2-digit' }), timeZone: 'UTC'
    })
  });
}

export function buildFinancialHourlyOption(rows, { currency = 'usd', hidden = [], timeZone = localTimeZone(), ...viewport } = {}) {
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const metrics = [...FINANCIALS_SERIES.slice(0, 2).map(series => ({ ...series,
    label: series.id === 'volume' ? 'HOURLY VOLUME' : series.label })), financialLineSeries('runePriceUsd')];
  const option = buildTimeSeriesOption(rows, {
    ...viewport, sourceGrain: 'hour', hidden, zoomId: 'financials-hour-window', minSpan: 2,
    axes: metrics.map((series, index) => ({ ...series, position: index ? 'right' : 'left',
      label: `${index === 0 ? 'VOLUME' : index === 1 ? 'INCOME' : 'RUNE PRICE'} · ${index === 2 ? 'USD' : currency.toUpperCase()}`,
      format: index === 2 ? priceAxisFormat.format : value => formatFinancialAmount(value, currency)
    })),
    series: metrics.map((series, index) => ({ ...series, axis: series.id,
      ...(index < 2 ? { fill: seriesFills[series.id], barMaxWidth: 20, order: 2 - index } : {}),
      data: rows.map(row => row[index === 2 ? 'runePriceUsd' : `${series.id}${suffix}`])
    })),
    xLabel: value => `${formatLocalHour(value, { timeZone })}${rows.find(row => row.day === value)?.partial ? '*' : ''}`,
    tooltip: row => timeSeriesTooltip([
      `${formatLocalHour(row.day, { timeZone, timeZoneName: 'short' })}${row.partial ? ' · IN PROGRESS' : ''}`,
      ...metrics.filter(series => !hidden.includes(series.id)).map((series, index) => ({ ...series,
        fill: seriesFills[series.id] || series.color,
        text: `${series.label}: ${formatFinancialAmount(row[series.id === 'runePriceUsd' ? series.id : `${series.id}${suffix}`], series.id === 'runePriceUsd' ? 'usd' : currency, false)}`
      })),
      `Through ${formatLocalHour(row.through * 1000, { timeZone, timeZoneName: 'short' })}`,
      `Gross liquidity fees: ${formatFinancialAmount(row.feesRune, 'rune', false)}`,
      'Income: retained earnings after REVSHARE. USD uses this hour’s closing RUNE price.',
      ...(row.partial ? ['Current hour includes only completed five-minute intervals; not extrapolated.'] : []),
      ...(row.volumeRune === null || row.incomeRune === null ? ['Some source data is unavailable.'] : [])
    ])
  });
  // Plan visible ticks before formatting: ECharts may ask for labels out of
  // order, and comparing adjacent source hours misses a skipped midnight tick.
  const start = option.dataZoom[0]?.startValue ?? 0;
  const end = option.dataZoom[0]?.endValue ?? rows.length - 1;
  const step = option.xAxis.axisLabel.interval + 1;
  const labels = localHourLabels(rows, { start, end, step, timeZone });
  // Separate date/time lines keep the transition label from colliding with
  // neighboring hours on a narrow chart, while all clock times stay aligned.
  return { ...option, grid: { ...option.grid, bottom: 44 }, xAxis: { ...option.xAxis,
    axisLabel: { ...option.xAxis.axisLabel, showMinLabel: true, hideOverlap: false,
      interval: (_index, value) => labels.has(value), formatter: value => labels.get(value) || '' }
  } };
}

// The chart controller retains its builder for the mounted chart's lifetime.
// Switch source behavior through options, not by replacing that function prop.
/** @param {any[]} rows @param {any} options */
export function buildFinancialChartOption(rows, options = {}) {
  return options.bucket === 'hour' ? buildFinancialHourlyOption(rows, options) : buildFinancialEChartsOption(rows, options);
}
