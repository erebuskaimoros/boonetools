import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';

export const FINANCIALS_SERIES = Object.freeze([
  { id: 'volume', label: 'DAILY VOLUME', mark: 'bar', color: palette.info },
  { id: 'income', label: 'SYSTEM INCOME', mark: 'bar', color: palette.accent },
  { id: 'bondingApr', label: 'BONDING APR', mark: 'line', color: palette.amber }
]);

export { utcDayIndices as financialChartIndices, utcDayWindow as financialChartWindow } from '../charts/viewport.js';
