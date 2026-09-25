import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { FINANCIALS_SERIES } from './series.js';
import { formatFinancialAmount, formatFinancialDay, formatFinancialPercent } from '../../../shared/financials/model.js';

export { utcDayZoomWindow as financialEChartsWindow } from '../charts/viewport.js';

const seriesFills = {
  volume: 'rgba(85,136,204,0.30)',
  income: 'rgba(0,204,102,0.35)',
  bondingApr: FINANCIALS_SERIES[2].color
};

export function financialEChartsTooltip(row, currency, hidden = []) {
  if (!row) return '';
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const amount = (value, unit = currency, compact = false) => formatFinancialAmount(value, unit, compact);
  const metrics = {
    volume: amount(row[`volume${suffix}`]), income: amount(row[`income${suffix}`]),
    bondingApr: formatFinancialPercent(row.bondingApr)
  };
  return timeSeriesTooltip([
    `${formatFinancialDay(row.day)} · UTC${row.partial ? ' · IN PROGRESS' : ''}`,
    ...FINANCIALS_SERIES.filter((series) => !hidden.includes(series.id)).map((series) => ({
      ...series, fill: seriesFills[series.id], text: `${series.label}: ${metrics[series.id]}`
    })),
    '',
    `Liquidity fees: ${amount(row.feesRune, 'rune')}`,
    `Block rewards: ${amount(row.blockRewardsRune, 'rune')}`,
    `Node rewards: ${amount(row.bondingEarningsRune, 'rune')}`,
    `Active bond: ${amount(row.activeBondRune, 'rune', true)}`,
    ...(row.partial ? [
      `Through ${new Date(row.through * 1000).toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false })} UTC`,
      'APR: elapsed-time annualized estimate'
    ] : []),
    ...(row.bondingApr === null ? ['Bonding APR: bond snapshot unavailable'] : []),
    ...(row.incomeUsd === null || row.volumeUsd === null ? ['Some source data is unavailable'] : [])
  ]);
}

export function buildFinancialEChartsOption(rows, { currency = 'usd', hidden = [], ...viewport } = {}) {
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const unit = currency === 'rune' ? 'RUNE' : 'USD';
  const apr = FINANCIALS_SERIES[2];
  // Feature-owned provisional segment: never bridge a missing APR day.
  const partialApr = rows.map((row, index) => (
    row.partial || (rows[index + 1]?.partial && row.bondingApr !== null) ? row.bondingApr : null
  ));
  return buildTimeSeriesOption(rows, {
    ...viewport, hidden, zoomId: 'financials-window', minSpan: 2,
    axes: FINANCIALS_SERIES.map((series, index) => ({
      ...series, position: index === 0 ? 'left' : 'right',
      label: `${index === 0 ? 'VOLUME' : index === 1 ? 'INCOME' : 'BONDING APR'} · ${index === 2 ? '%' : unit}`,
      format: index === 2 ? formatFinancialPercent : (value) => formatFinancialAmount(value, currency)
    })),
    series: [
      ...FINANCIALS_SERIES.slice(0, 2).map((series, index) => ({
        ...series, aggregate: 'sum', axis: series.id, fill: seriesFills[series.id], barMaxWidth: 20, order: 2 - index,
        data: rows.map((row) => row[`${series.id}${suffix}`])
      })),
      { ...apr, axis: apr.id, aggregate: 'mean', aggregateData: rows.map(row => row.bondingApr), rollingData: rows.map(row => row.bondingApr), data: rows.map((row) => row.partial ? null : row.bondingApr) },
      { ...apr, id: 'bondingApr-partial', visibilityId: apr.id, axis: apr.id,
        label: 'BONDING APR · IN PROGRESS', legend: false, rolling: false, data: partialApr, dashed: true,
        symbolSize: (_value, item) => rows[item.dataIndex]?.partial ? 8 : 0 }
    ],
    tooltip: (row) => financialEChartsTooltip(row, currency, hidden),
    xLabel: (day, index) => rows[index]?.partial ? 'Today*' : new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short', ...(rows.length <= 365 ? { day: 'numeric' } : { year: '2-digit' }), timeZone: 'UTC'
    })
  });
}
