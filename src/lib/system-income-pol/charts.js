import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';

export const POL_DEPOSIT_SERIES = Object.freeze([
  { id: 'daily', label: 'DAILY POL DEPOSITED', mark: 'bar', color: palette.accent },
  { id: 'cumulative', label: 'CUMULATIVE POL DEPOSITED', mark: 'line', color: palette.amber, rolling: false }
]);

export function polChartValue(value, unit, compact = false) {
  if (!Number.isFinite(value)) return 'Unavailable';
  const formatted = new Intl.NumberFormat('en-US', {
    notation: compact ? 'compact' : 'standard',
    minimumFractionDigits: compact ? 0 : 2, maximumFractionDigits: 2
  }).format(value);
  return unit === 'usd' ? `$${formatted}` : `${formatted}${compact ? '' : ' RUNE'}`;
}

function priceDetail(row) {
  return `${row.priceProvisional ? 'LATEST' : 'DAY-END'} PRICE: ${row.runePriceUsd > 0
    ? `$${row.runePriceUsd.toLocaleString('en-US', { maximumFractionDigits: 6 })} / RUNE`
    : 'UNAVAILABLE'}${row.priceProvisional ? ' · PROVISIONAL' : ''}`;
}

export function polDepositTooltip(row, unit = 'rune', hidden = []) {
  return timeSeriesTooltip([
    `${row.day} · UTC${row.partial ? ' · PARTIAL' : ''}`,
    ...POL_DEPOSIT_SERIES.map((item, index) => ({
      ...item, text: `${item.label}: ${polChartValue(index ? row.cumulativeDepositedValue : row.depositedPlotValue, unit)}`
    })).filter(item => !hidden.includes(item.id)),
    ...(unit === 'usd' ? [priceDetail(row)] : [])
  ]);
}

export function buildSystemIncomePolDepositOption(rows, { unit = 'rune', window = null, width = 1000, hidden = [], analysis = null } = {}) {
  return buildTimeSeriesOption(rows, {
    width, window, hidden, analysis,
    tooltip: (row) => polDepositTooltip(row, unit, hidden),
    axes: POL_DEPOSIT_SERIES.map((item, index) => ({
      ...item, label: `${index ? 'CUMULATIVE' : 'DAILY'} · ${unit.toUpperCase()}`,
      position: index ? 'right' : 'left', format: (value) => polChartValue(value, unit, true)
    })),
    series: POL_DEPOSIT_SERIES.map((item, index) => ({
      ...item, aggregate: index ? 'last' : 'sum', axis: item.id,
      data: rows.map((row) => index ? row.cumulativeDepositedValue : row.depositedPlotValue),
      fill: 'rgba(0,204,102,0.82)', barMaxWidth: 28, symbolSize: index ? 6 : 0
    }))
  });
}

export function polFeeDetails(row, unit = 'usd') {
  return [
    ...(row.missingReason ? [row.missingReason] : []),
    ...(row.feeCoverage?.totalHours > 0 ? [`COVERAGE · ${row.feeCoverage.coveredHours}/${row.feeCoverage.totalHours} POOL-HOURS`] : []),
    ...(unit === 'usd' ? [priceDetail(row)] : []),
    ...(row.provisional ? ['PARTIAL / PROVISIONAL'] : []),
    ...(row.feeCoverage?.seededHours > 0 ? ['INCLUDES SEEDED OWNERSHIP'] : [])
  ];
}

export function polFeeTooltip(row, unit = 'usd', hidden = []) {
  return timeSeriesTooltip([
    `${row.day} · UTC`,
    ...(!hidden.includes('fees') ? [{ id: 'fees', color: palette.amber, text: `EST. FEES: ${polChartValue(row.value, unit)}` }] : []),
    ...polFeeDetails(row, unit)
  ]);
}

export function buildSystemIncomePolFeeOption(rows, { unit = 'usd', width = 1000, selectedDay = '', hidden = [], analysis = null } = {}) {
  return buildTimeSeriesOption(rows, {
    width, hidden, analysis, zoom: false, compact: true, tooltipEnabled: !selectedDay,
    tooltip: (row) => polFeeTooltip(row, unit, hidden),
    axes: [{ id: 'fees', label: 'DAILY EST. FEES', position: 'left', color: palette.amber, format: (value) => polChartValue(value, unit, true) }],
    series: [{
      id: 'fees', label: 'DAILY EST. FEES', aggregate: 'sum', mark: 'bar', axis: 'fees', color: palette.amber, barMaxWidth: 32,
      data: rows.map((row) => row.value === null ? null : ({
        value: row.value,
        itemStyle: { color: row.provisional ? 'rgba(212,160,23,0.45)' : palette.amber, borderType: row.provisional ? 'dashed' : 'solid' }
      })),
      markers: rows.filter((row) => row.value === null || row.value === 0).map((row) => ({
        day: row.day, value: 0, text: row.value === null ? '×' : '—', color: row.value === null ? palette.muted : palette.amber
      }))
    }]
  });
}
