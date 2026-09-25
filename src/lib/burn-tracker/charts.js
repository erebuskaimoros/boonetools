import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';
import { buildTimeSeriesOption, timeSeriesTooltip, utcDayLabel } from '../charts/time-series.js';

export const BURN_BAR_COLOR = '#f28c28';
export const BURN_SERIES = Object.freeze([
  { id: 'daily', label: 'DAILY BURN', mark: 'bar', color: BURN_BAR_COLOR },
  { id: 'cumulative', label: 'CUMULATIVE BURN', mark: 'line', color: palette.amber },
  { id: 'price', label: 'RUNE / USD', mark: 'line', color: palette.info }
]);
const burnFill = (row) => row.partial ? 'rgba(242,140,40,0.16)' : 'rgba(242,140,40,0.34)';
const rune = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const usdBurn = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usdPrice = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

function compact(value, prefix = '') {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const amount = Number(value);
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000) return `${prefix}${(amount / 1_000_000).toFixed(2)}m`;
  if (absolute >= 1_000) return `${prefix}${(amount / 1_000).toFixed(absolute < 10_000 ? 2 : 1)}k`;
  return `${prefix}${amount.toFixed(absolute < 10 ? 2 : 0)}`;
}

export function burnTrackerTooltip(row, { unit = 'rune', hidden = ['price'] } = {}) {
  const showUsd = unit === 'usd';
  const values = [showUsd ? row.burnedUsd : row.burnedRune,
    showUsd ? row.cumulativeBurnedUsd : row.cumulativeBurnedRune, row.runePriceUsd];
  return timeSeriesTooltip([
    `${utcDayLabel(row.day)} · UTC`,
    ...BURN_SERIES.flatMap((series, index) => hidden.includes(series.id) ? [] : [{
      ...series, fill: index === 0 ? burnFill(row) : series.color,
      text: `${series.label}: ${values[index] == null ? 'unavailable' : index === 2
        ? usdPrice.format(values[index]) : showUsd ? usdBurn.format(values[index]) : `${rune.format(values[index])} ᚱ`}`
    }]),
    ...(row.partial ? ['LIVE PARTIAL UTC DAY'] : []),
    ...(row.source === 'missing' ? ['MISSING SOURCE DAY'] : [])
  ]);
}

export function buildBurnTrackerOption(rows, { unit = 'rune', hidden = ['price'], ...viewport } = {}) {
  const showUsd = unit === 'usd';
  const units = showUsd ? '$' : 'ᚱ';
  return buildTimeSeriesOption(rows, {
    ...viewport, hidden,
    axes: BURN_SERIES.map((series, index) => ({
      ...series, position: index === 0 ? 'left' : 'right', baseline: index === 0 ? 'zero' : 'auto',
      label: index === 2 ? 'RUNE / USD' : `${index === 0 ? 'DAILY' : 'CUMULATIVE'} ${units}`,
      format: (value) => compact(value, index === 2 || showUsd ? '$' : '')
    })),
    series: [
      { ...BURN_SERIES[0], aggregate: 'sum', axis: 'daily', barMaxWidth: 22, fill: (item) => burnFill(rows[item.dataIndex]),
        data: rows.map((row) => showUsd ? row.burnedUsd : row.burnedRune) },
      // Values are normalized before range selection; never sum the viewport.
      { ...BURN_SERIES[1], aggregate: 'last', axis: 'cumulative', smooth: 0.08,
        data: rows.map((row) => showUsd ? row.cumulativeBurnedUsd : row.cumulativeBurnedRune) },
      { ...BURN_SERIES[2], aggregate: 'last', axis: 'price', dashed: true, lineWidth: 1.5, smooth: 0.12,
        data: rows.map((row) => row.runePriceUsd) }
    ],
    tooltip: (row) => burnTrackerTooltip(row, { unit, hidden })
  });
}
