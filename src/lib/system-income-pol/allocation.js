import { formatE8Asset, formatE8Rune, formatE8Usd } from './model.js';
import { polPoolSeries } from './charts.js';
import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';
import { timeSeriesTooltip, TIME_SERIES_FONT } from '../charts/time-series.js';

function nonnegativeE8(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function allocationShare(percent) {
  if (!Number.isFinite(percent)) return '—';
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
}

// Compare unlike assets using their reconciled USD values, never token counts.
// Unpriced holdings stay in the key but do not become invented zero-value slices.
export function buildPolAssetAllocation(inventory = []) {
  const totalE8 = inventory.reduce((sum, item) => sum + (nonnegativeE8(item.valueUsdE8) ?? 0), 0);
  const assets = inventory.map(item => {
    const usdE8 = nonnegativeE8(item.valueUsdE8);
    const series = polPoolSeries(item.asset);
    const color = item.asset === 'THOR.RUNE' ? palette.accent
      : item.ticker === 'USDT' && item.asset.startsWith('BSC.') ? '#88cbbb' : series.color;
    return {
      ...item, color, label: item.asset.split('-')[0],
      value: usdE8 === null ? null : usdE8 / 1e8,
      percent: usdE8 === null || totalE8 <= 0 ? null : 100 * usdE8 / totalE8,
      amountLabel: item.ticker === 'RUNE' ? formatE8Rune(item.amountE8) : formatE8Asset(item.amountE8),
      valueLabel: usdE8 === null ? 'USD unavailable' : formatE8Usd(item.valueUsdE8)
    };
  });
  return {
    assets, totalE8,
    totalLabel: formatE8Usd(String(totalE8)),
    incomplete: assets.some(item => item.value === null),
    hasValue: totalE8 > 0
  };
}

export function buildPolAssetAllocationOption(allocation) {
  const slices = allocation.assets.filter(item => item.value > 0);
  const runeIndex = slices.findIndex(item => item.asset === 'THOR.RUNE');
  const total = slices.reduce((sum, item) => sum + item.value, 0);
  // Center RUNE at six o'clock without changing values or key/slice order.
  // At its usual 50% share this places the entire semicircle below the center.
  const beforeRune = slices.slice(0, runeIndex).reduce((sum, item) => sum + item.value, 0);
  const startAngle = runeIndex < 0 ? 90
    : (270 + 360 * (beforeRune + slices[runeIndex].value / 2) / total) % 360;
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: TIME_SERIES_FONT },
    tooltip: {
      trigger: 'item', confine: true,
      backgroundColor: palette.surface, borderColor: palette.borderStrong,
      textStyle: { color: palette.text, fontFamily: TIME_SERIES_FONT, fontSize: 12 },
      formatter: ({ data }) => timeSeriesTooltip([
        { id: data.id, color: data.itemStyle.color, text: data.name },
        `${data.amountLabel} ${data.ticker}`,
        `${data.valueLabel} · ${allocationShare(data.percent)} of ${allocation.incomplete ? 'priced' : 'total'} holdings`
      ])
    },
    series: [{
      id: 'pol-asset-allocation', type: 'pie', radius: '88%', center: ['50%', '50%'],
      startAngle, clockwise: true,
      // Keep true proportions: tiny positions are not enlarged to a minimum angle.
      minAngle: 0, stillShowZeroSum: false, selectedMode: false,
      label: { show: false }, labelLine: { show: false },
      emphasis: { scale: false, itemStyle: { borderColor: palette.text, borderWidth: 1 } },
      data: slices.map(item => ({
        ...item, id: item.asset, name: item.label,
        itemStyle: { color: item.color, borderColor: palette.surface, borderWidth: 1 }
      }))
    }]
  };
}
