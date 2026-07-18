export const TERMINAL_CHART_PALETTE = Object.freeze({
  page: '#080808',
  surface: '#0a0a0a',
  surfaceHover: '#0d0d0d',
  grid: '#111111',
  border: '#1a1a1a',
  borderStrong: '#333333',
  text: '#c8c8c8',
  muted: '#666666',
  accent: '#00cc66',
  amber: '#d4a017',
  info: '#5588cc',
  error: '#dc3545'
});

export function terminalChartFont(size = 10, family = "'JetBrains Mono', monospace") {
  return { family, size };
}
