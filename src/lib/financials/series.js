import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';

export const FINANCIALS_SERIES = Object.freeze([
  { id: 'volume', label: 'DAILY VOLUME', mark: 'bar', color: palette.info },
  { id: 'income', label: 'SYSTEM INCOME', mark: 'bar', color: palette.accent },
  { id: 'bondingApr', label: 'BONDING APR', mark: 'line', color: palette.amber }
]);

export const RUNE_PRICE_SERIES = Object.freeze({ id: 'runePriceUsd', label: 'RUNE PRICE', mark: 'line', color: palette.amber });
export const financialLineSeries = (metric = 'runePriceUsd') => metric === 'bondingApr' ? FINANCIALS_SERIES[2] : RUNE_PRICE_SERIES;

export { utcDayIndices as financialChartIndices, utcDayWindow as financialChartWindow } from '../charts/viewport.js';
