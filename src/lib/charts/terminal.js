export const TERMINAL_CHART_PALETTE = Object.freeze({
  page: '#080808',
  surface: '#0a0a0a',
  surfaceHover: '#0d0d0d',
  grid: '#111111',
  border: '#1a1a1a',
  borderStrong: '#333333',
  text: '#e8e8e8',
  muted: '#c8c8c8',
  accent: '#00cc66',
  amber: '#d4a017',
  info: '#5588cc',
  error: '#dc3545'
});

export function terminalChartFont(size = 11, family = "'JetBrains Mono', monospace") {
  return { family, size };
}

function setChartLegendCursor(event, cursor) {
  const target = event?.native?.target;
  if (target?.style) target.style.cursor = cursor;
}

export function toggleChartLegendItem(_event, legendItem, legend) {
  const chart = legend?.chart;
  if (!chart) return;

  if (Number.isInteger(legendItem?.datasetIndex)) {
    const datasetIndex = legendItem.datasetIndex;
    if (chart.isDatasetVisible(datasetIndex)) chart.hide(datasetIndex);
    else chart.show(datasetIndex);
    return;
  }

  if (Number.isInteger(legendItem?.index) && typeof chart.toggleDataVisibility === 'function') {
    chart.toggleDataVisibility(legendItem.index);
    chart.update();
  }
}

export const INTERACTIVE_CHART_LEGEND = Object.freeze({
  onClick: toggleChartLegendItem,
  onHover: (event) => setChartLegendCursor(event, 'pointer'),
  onLeave: (event) => setChartLegendCursor(event, 'default')
});

export function toggleHiddenChartTrend(hiddenTrendIds, trendId) {
  const currentIds = Array.isArray(hiddenTrendIds) ? hiddenTrendIds : [];
  return currentIds.includes(trendId)
    ? currentIds.filter((currentId) => currentId !== trendId)
    : [...currentIds, trendId];
}

export function isChartTrendVisible(hiddenTrendIds, trendId) {
  return !Array.isArray(hiddenTrendIds) || !hiddenTrendIds.includes(trendId);
}
