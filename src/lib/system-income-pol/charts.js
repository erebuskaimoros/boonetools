import { buildTimeSeriesOption, timeSeriesTooltip, escapeTooltipText } from '../charts/time-series.js';
import { calendarGroups, DAY_MS } from '../charts/analytics.js';
import { getAssetLogo } from '../constants/assets.js';
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

// Fixed per-asset colors remain stable across range, unit and live pool changes.
const POOL_COLORS = [palette.accent, palette.info, '#bcbcbc', '#66bbaa', '#88aacc', '#aabb77'];
export function polPoolSeries(asset) {
  const [chain, token = chain] = asset.split('.');
  const ticker = token.split('-')[0];
  let hash = 0;
  for (const character of asset) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const color = ticker === 'USDT' ? palette.accent : asset === 'XRP.XRP' ? palette.info
    : asset === 'TRON.TRX' ? '#bcbcbc' : asset === 'ZEC.ZEC' ? '#aabb77' : POOL_COLORS[hash % POOL_COLORS.length];
  return { id: `pool:${asset}`, asset, label: `${ticker} · ${chain}`, color, mark: 'bar' };
}

// Same feature-owned reductions for calendar hover and keyboard inspection.
export function polDepositBuckets(rows, grain = 'day') {
  if (grain === 'day') return rows;
  return calendarGroups(rows, grain).map(group => {
    const sample = group.indices.map(index => rows[index]);
    const first = sample[0], last = sample.at(-1);
    const consecutive = sample.length === (Date.parse(last.day) - Date.parse(first.day)) / DAY_MS + 1;
    const sum = values => consecutive && values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;
    const assets = [...new Set(sample.flatMap(row => (row.poolDeposits || []).map(pool => pool.asset)))];
    return {
      ...last, day: group.startDay, fromDay: first.day, throughDay: last.day,
      partial: sample.length < group.days || sample.some(row => row.partial || row.priceProvisional),
      depositedPlotRune: sum(sample.map(row => row.depositedPlotRune)),
      depositedPlotValue: sum(sample.map(row => row.depositedPlotValue)),
      unattributedRune: sum(sample.map(row => row.unattributedRune ?? row.depositedPlotRune)),
      unattributedValue: sum(sample.map(row => row.unattributedValue ?? row.depositedPlotValue)),
      poolDeposits: assets.map(asset => ({ asset,
        rune: sum(sample.map(row => row.poolDeposits?.find(pool => pool.asset === asset)?.rune ?? 0)),
        value: sum(sample.map(row => {
          const pool = row.poolDeposits?.find(pool => pool.asset === asset);
          return pool ? pool.value : 0;
        }))
      }))
    };
  });
}

export function polDepositTooltip(row, unit = 'rune', hidden = []) {
  const pools = (row.poolDeposits || []).filter(pool => pool.rune !== 0).map(pool => ({ ...pool, ...polPoolSeries(pool.asset) }));
  if ((row.unattributedRune ?? row.depositedPlotRune) !== 0) pools.push({
    id: 'daily', label: 'UNATTRIBUTED', color: palette.muted,
    rune: row.unattributedRune ?? row.depositedPlotRune, value: row.unattributedValue ?? row.depositedPlotValue
  });
  const total = unit === 'usd' ? row.depositedPlotValue : row.depositedPlotRune;
  const header = timeSeriesTooltip([
    `${row.fromDay ? `${row.fromDay} → ${row.throughDay}` : row.day} · UTC${row.partial ? ' · PARTIAL' : ''}`,
    `TOTAL DEPOSITED · ALL POOLS: ${polChartValue(row.depositedPlotValue, unit)}`
  ]);
  const lines = pools.filter(pool => !hidden.includes(pool.id)).map(pool => {
    const percentage = total > 0 && Number.isFinite(pool.value) ? ` · ${(100 * pool.value / total).toFixed(1)}%` : '';
    const logo = pool.asset && getAssetLogo(pool.asset);
    const icon = logo?.startsWith('/assets/') ? `<img alt="" src="${escapeTooltipText(logo)}" width="14" height="14" style="vertical-align:middle;margin-right:5px">` : '';
    return icon + timeSeriesTooltip([{ ...pool, text: `${pool.label}: ${polChartValue(pool.value, unit)}${percentage}` }]);
  });
  return [header, ...lines, timeSeriesTooltip([
    ...(!hidden.includes('cumulative') ? [{ ...POL_DEPOSIT_SERIES[1], text: `CUMULATIVE · ALL POOLS: ${polChartValue(row.cumulativeDepositedValue, unit)}` }] : []),
    ...(row.unattributedRune > 0 ? ['Unattributed: pool breakdown unavailable for part of this total.'] : []),
    ...(hidden.length ? ['Totals include hidden pools. Percentages are of all deposits.'] : []),
    ...(unit === 'usd' ? [row.fromDay ? 'USD sums each day at its own closing price; open-day prices are provisional.' : priceDetail(row)] : [])
  ])].filter(Boolean).join('<br>');
}

export function buildSystemIncomePolDepositOption(rows, { unit = 'rune', window = null, width = 1000, hidden = [], analysis = null } = {}) {
  const assets = [...new Set(rows.flatMap(row => (row.poolDeposits || []).map(pool => pool.asset)))].sort();
  const pools = assets.map(polPoolSeries);
  for (const pool of pools) {
    if (pools.some(other => other.id !== pool.id && other.label === pool.label)) pool.label += ` · ${pool.asset.split('-').slice(1).join('-')}`;
  }
  const needsUnattributed = !pools.length || rows.some(row => (row.unattributedRune ?? row.depositedPlotRune) > 0);
  return buildTimeSeriesOption(rows, {
    width, window, hidden, analysis,
    tooltip: (row) => polDepositTooltip(row, unit, hidden),
    groupedTooltip: (_row, context) => polDepositTooltip(polDepositBuckets(context.rows, context.grain)[0], unit, context.hidden),
    axes: POL_DEPOSIT_SERIES.map((item, index) => ({
      ...item, label: `${index ? 'CUMULATIVE' : 'DAILY'} · ${unit.toUpperCase()}`,
      position: index ? 'right' : 'left', format: (value) => polChartValue(value, unit, true)
    })),
    series: [
      ...pools.map(pool => ({ ...pool, aggregate: 'sum', axis: 'daily', stack: 'deposits', barMaxWidth: 28,
        data: rows.map(row => {
          const deposit = row.poolDeposits?.find(item => item.asset === pool.asset);
          return deposit ? deposit.value : 0;
        })
      })),
      ...(needsUnattributed ? [{ ...POL_DEPOSIT_SERIES[0], label: 'UNATTRIBUTED', color: palette.muted,
        aggregate: 'sum', axis: 'daily', stack: 'deposits', barMaxWidth: 28,
        data: rows.map(row => row.unattributedValue === undefined ? row.depositedPlotValue : row.unattributedValue)
      }] : []),
      { ...POL_DEPOSIT_SERIES[1], aggregate: 'last', axis: 'cumulative', symbolSize: 6,
        data: rows.map(row => row.cumulativeDepositedValue) }
    ]
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
