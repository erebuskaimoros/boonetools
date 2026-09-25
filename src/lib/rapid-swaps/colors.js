import { TERMINAL_CHART_PALETTE } from '../charts/terminal.js';

export const RAPID_SWAP_CHART_COLORS = Object.freeze({
  green: TERMINAL_CHART_PALETTE.accent,
  greenAlpha: 'rgba(0, 204, 102, 0.3)',
  amber: TERMINAL_CHART_PALETTE.amber,
  amberAlpha: 'rgba(212, 160, 23, 0.3)',
  blue: TERMINAL_CHART_PALETTE.info,
  blueAlpha: 'rgba(85, 136, 204, 0.3)',
  red: '#cc4444',
  redAlpha: 'rgba(204, 68, 68, 0.3)',
  yellow: '#cccc33',
  yellowAlpha: 'rgba(204, 204, 51, 0.3)',
  grid: TERMINAL_CHART_PALETTE.border,
  text: TERMINAL_CHART_PALETTE.muted,
  bg: TERMINAL_CHART_PALETTE.surfaceHover
});
