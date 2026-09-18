import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';

export const FINANCIALS_SERIES = Object.freeze([
  { id: 'volume', label: 'DAILY VOLUME', color: palette.info },
  { id: 'income', label: 'SYSTEM INCOME', color: palette.accent },
  { id: 'bondingApr', label: 'BONDING APR', color: palette.amber }
]);

// Both preview renderers use inclusive UTC-day bounds, not percentages of a
// changing live dataset. The financial model still owns all aggregation.
export function financialChartIndices(rows, window = null) {
  if (!rows.length) return { start: 0, end: 0 };
  if (!window) return { start: 0, end: rows.length - 1 };
  const start = rows.findIndex((row) => row.day >= window.startDay);
  const end = rows.findLastIndex((row) => row.day <= window.endDay);
  return start < 0 || end < start
    ? { start: 0, end: rows.length - 1 }
    : { start, end };
}

export function financialChartWindow(rows, start, end) {
  if (!rows.length || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const first = Math.max(0, Math.min(rows.length - 1, Math.ceil(start)));
  const last = Math.max(first, Math.min(rows.length - 1, Math.floor(end)));
  return first === 0 && last === rows.length - 1
    ? null : { startDay: rows[first].day, endDay: rows[last].day };
}
