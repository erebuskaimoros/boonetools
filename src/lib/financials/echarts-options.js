import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';
import { FINANCIALS_SERIES, financialChartIndices, financialChartWindow } from './series.js';
import { formatFinancialAmount, formatFinancialDay, formatFinancialPercent } from '../../../shared/financials/model.js';

const fontFamily = "'JetBrains Mono', monospace";
const seriesFills = {
  volume: 'rgba(85,136,204,0.30)',
  income: 'rgba(0,204,102,0.35)',
  bondingApr: palette.amber
};

const escapeTooltipText = (text) => String(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function financialEChartsTooltip(row, currency, hidden = []) {
  if (!row) return '';
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const amount = (value, unit = currency, compact = false) => formatFinancialAmount(value, unit, compact);
  const metrics = {
    volume: amount(row[`volume${suffix}`]),
    income: amount(row[`income${suffix}`]),
    bondingApr: formatFinancialPercent(row.bondingApr)
  };
  return [
    `${formatFinancialDay(row.day)} · UTC${row.partial ? ' · IN PROGRESS' : ''}`,
    ...FINANCIALS_SERIES.filter((series) => !hidden.includes(series.id)).map((series) => ({
      series, text: `${series.label}: ${metrics[series.id]}`
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
  ].map((line) => {
    if (typeof line === 'string') return escapeTooltipText(line);
    const { series, text } = line;
    // HTML supports square, outlined swatches matching the bars and APR line.
    // Escape all text; only the fixed local series palette enters the markup.
    return `<span aria-hidden="true" data-series="${series.id}" style="display:inline-block;width:12px;height:12px;box-sizing:border-box;vertical-align:middle;margin-right:6px;border-radius:0;border:1px solid ${series.color};background-color:${seriesFills[series.id]}"></span> ${escapeTooltipText(text)}`;
  }).join('<br>');
}

export function financialEChartsWindow(rows, zoom) {
  const last = rows.length - 1;
  const index = (value, percent, fallback) => {
    if (typeof value === 'string') {
      const found = rows.findIndex((row) => row.day === value);
      if (found >= 0) return found;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return typeof percent === 'number' && Number.isFinite(percent) ? last * percent / 100 : fallback;
  };
  return financialChartWindow(rows, index(zoom?.startValue, zoom?.start, 0), index(zoom?.endValue, zoom?.end, last));
}

export function buildFinancialEChartsOption(rows, { currency = 'usd', hidden = [], window = null, width = 1000 } = {}) {
  const wide = width >= 600;
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const unit = currency === 'rune' ? 'RUNE' : 'USD';
  const { start, end } = financialChartIndices(rows, window);
  const rightAxes = FINANCIALS_SERIES.slice(1).filter((series) => !hidden.includes(series.id));
  const axisSpacing = wide ? 86 : 62;
  const values = (id, field) => hidden.includes(id) ? [] : rows.map((row) => row[field]);
  const line = {
    type: 'line', yAxisIndex: 2, connectNulls: false, smooth: false,
    symbol: 'circle', showSymbol: false, z: 3,
    itemStyle: { color: palette.amber },
    emphasis: { disabled: true },
    lineStyle: { width: 2, color: palette.amber }
  };

  // A separate, linked series draws only the provisional final segment.
  // Never bridge a missing APR day to reach today's estimate.
  const partialApr = rows.map((row, index) => (
    row.partial || (rows[index + 1]?.partial && row.bondingApr !== null)
      ? row.bondingApr : null
  ));
  const yAxis = FINANCIALS_SERIES.map((series, index) => ({
    id: series.id, type: 'value', show: !hidden.includes(series.id),
    position: index === 0 ? 'left' : 'right',
    offset: index === 0 ? 0 : Math.max(0, rightAxes.findIndex((axis) => axis.id === series.id)) * axisSpacing,
    name: wide ? `${index === 0 ? 'VOLUME' : index === 1 ? 'INCOME' : 'BONDING APR'} · ${index === 2 ? '%' : unit}` : '',
    nameLocation: 'middle', nameGap: wide ? 61 : 0,
    nameTextStyle: { color: series.color, fontFamily, fontSize: 11 },
    min: 0, max: ({ max }) => max > 0 ? max * 1.05 : 1, splitNumber: 5,
    axisLine: { show: true, lineStyle: { color: series.color } },
    axisTick: { show: false },
    splitLine: { show: index === 0, lineStyle: { color: palette.grid } },
    axisLabel: {
      color: series.color, fontFamily, fontSize: 11, hideOverlap: true,
      formatter: (value) => index === 2 ? formatFinancialPercent(value) : formatFinancialAmount(value, currency)
    }
  }));

  return {
    animation: false, backgroundColor: 'transparent', textStyle: { fontFamily },
    grid: {
      left: hidden.includes('volume') ? 12 : wide ? 88 : 64,
      right: rightAxes.length ? rightAxes.length * axisSpacing + (wide ? 14 : 8) : 12,
      top: 32, bottom: 30
    },
    tooltip: {
      trigger: 'axis', renderMode: 'html', confine: true,
      backgroundColor: palette.surface, borderColor: palette.borderStrong, borderWidth: 1,
      padding: 12, textStyle: { color: palette.text, fontFamily, fontSize: 12, lineHeight: 18 },
      axisPointer: { type: 'line', lineStyle: { color: palette.muted, type: 'dashed', width: 1 } },
      formatter: (items) => {
        const first = Array.isArray(items) ? items[0] : items;
        const row = rows.find((point) => point.day === first?.axisValue) ?? rows[first?.dataIndex];
        return financialEChartsTooltip(row, currency, hidden);
      }
    },
    toolbox: {
      right: rightAxes.length * axisSpacing + (wide ? 14 : 8), top: 0, itemSize: 13, itemGap: 12,
      iconStyle: { borderColor: palette.muted },
      emphasis: { iconStyle: { borderColor: palette.info }, textStyle: { fontFamily, fontSize: 12 } },
      feature: { dataZoom: {
        xAxisIndex: 0, yAxisIndex: 'none',
        title: { zoom: 'Drag to zoom', back: 'Undo zoom' },
        brushStyle: { color: 'rgba(85,136,204,0.12)', borderColor: palette.info, borderWidth: 1 }
      } }
    },
    dataZoom: [{
      id: 'financials-window', type: 'inside', xAxisIndex: 0,
      startValue: start, endValue: end, minValueSpan: Math.min(2, Math.max(0, rows.length - 1)),
      filterMode: 'filter', zoomOnMouseWheel: false, moveOnMouseWheel: false,
      moveOnMouseMove: false, preventDefaultMouseMove: false, throttle: 0
    }],
    xAxis: {
      type: 'category', data: rows.map((row) => row.day), boundaryGap: true,
      axisLine: { lineStyle: { color: palette.border } }, axisTick: { show: false },
      axisLabel: {
        color: palette.muted, fontFamily, fontSize: 11, hideOverlap: true,
        interval: Math.max(0, Math.ceil((end - start + 1) / (wide ? 9 : 4)) - 1),
        formatter: (day, index) => rows[index]?.partial ? 'Today*' : new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
          month: 'short', ...(rows.length <= 365 ? { day: 'numeric' } : { year: '2-digit' }), timeZone: 'UTC'
        })
      }
    },
    yAxis,
    series: [
      {
        id: 'volume', name: 'DAILY VOLUME', type: 'bar', yAxisIndex: 0,
        data: values('volume', `volume${suffix}`), z: 2, barMaxWidth: 20,
        itemStyle: { color: seriesFills.volume, borderColor: palette.info, borderWidth: 1, borderRadius: 0 },
        emphasis: { disabled: true }
      },
      {
        id: 'income', name: 'SYSTEM INCOME', type: 'bar', yAxisIndex: 1,
        data: values('income', `income${suffix}`), z: 1, barMaxWidth: 20,
        itemStyle: { color: seriesFills.income, borderColor: palette.accent, borderWidth: 1, borderRadius: 0 },
        emphasis: { disabled: true }
      },
      {
        ...line, id: 'bondingApr', name: 'BONDING APR',
        data: hidden.includes('bondingApr') ? [] : rows.map((row) => row.partial ? null : row.bondingApr)
      },
      {
        ...line, id: 'bondingApr-partial', name: 'BONDING APR · IN PROGRESS',
        data: hidden.includes('bondingApr') ? [] : partialApr,
        lineStyle: { ...line.lineStyle, type: 'dashed' },
        showSymbol: true, symbolSize: (_value, item) => rows[item.dataIndex]?.partial ? 8 : 0
      }
    ]
  };
}
