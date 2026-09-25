import { utcDayIndices, utcDayWindow, utcDayZoomWindow, zoomUtcDayWindow } from './viewport.js';

// Kept independent of the DOM/renderer so lifecycle and viewport behavior can
// be exercised with both a test double and the real ECharts SSR model.
export function createTimeSeriesController(chart, initial, { buildOption, width, onZoom = (_window) => {}, onSelect = null, onHover = null }) {
  let state = initial;
  let disposed = false;
  let zoomId;
  let minPoints = 2;
  let renderedPoints = initial.points;

  function render() {
    if (disposed) return;
    const { _spec, _rows, ...option } = buildOption(state.points, { ...state.options, window: state.window, width: width() });
    renderedPoints = _rows || state.points;
    zoomId = option.dataZoom?.[0]?.id;
    minPoints = (option.dataZoom?.[0]?.minValueSpan ?? 1) + 1;
    chart.setOption(option, { replaceMerge: ['series', 'yAxis', 'dataZoom'], silent: true });
  }

  function setWindow(window) {
    if (disposed || !zoomId) return;
    state = { ...state, window };
    render();
    onZoom(window);
  }

  function handleZoom() {
    if (disposed || !zoomId) return;
    const zoom = chart.getOption().dataZoom?.find((item) => item.id === zoomId);
    const window = utcDayZoomWindow(renderedPoints, zoom);
    const last = window && renderedPoints.find(point => point.day === window.endDay);
    setWindow(window && last?.endDay ? { ...window, endDay: last.endDay } : window);
  }
  const resetZoom = () => setWindow(state.resetWindow ?? null);
  function pointDay(event) {
    const pixel = [event.offsetX, event.offsetY];
    if (!chart.containPixel({ gridIndex: 0 }, pixel)) return null;
    const index = Math.round(chart.convertFromPixel({ xAxisIndex: 0 }, pixel[0]));
    return renderedPoints[index]?.throughDay || renderedPoints[index]?.day || null;
  }
  // Overview charts can select any day, including blank/missing bars. Canvas
  // selection is optional; keyboard details remain ordinary feature-owned HTML.
  function selectPoint(event) {
    if (disposed || !onSelect || zoomId) return;
    const day = pointDay(event);
    if (day) onSelect(day);
  }
  const hoverPoint = (event) => { if (!disposed) onHover?.(pointDay(event)); };
  const clearHover = () => { if (!disposed) onHover?.(null); };
  chart.on('datazoom', handleZoom);
  chart.getZr()?.on('dblclick', resetZoom);
  if (onSelect) chart.getZr()?.on('click', selectPoint);
  if (onHover) {
    chart.getZr()?.on('mousemove', hoverPoint);
    chart.getZr()?.on('globalout', clearHover);
  }

  try {
    render();
    if (zoomId) chart.dispatchAction({ type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: true }, { silent: true });
  } catch (error) {
    chart.dispose();
    throw error;
  }

  return {
    update(next) {
      state = { ...next, window: next.window === undefined ? state.window : next.window };
      // A rolling source may eventually retire a selected boundary. Report the
      // clamped dates so the HTML range/summary cannot disagree with the plot.
      let clamped = false;
      if (state.window && state.points.length) {
        const { start, end } = utcDayIndices(state.points, state.window);
        const window = utcDayWindow(state.points, start, end);
        clamped = window?.startDay !== state.window.startDay || window?.endDay !== state.window.endDay;
        if (clamped) state = { ...state, window };
      }
      render();
      if (clamped && !disposed) onZoom(state.window);
    },
    resetZoom,
    zoomBy(factor) { setWindow(zoomUtcDayWindow(state.points, state.window, factor, minPoints)); },
    resize() { if (!disposed) { chart.resize(); render(); } },
    destroy() {
      if (disposed) return;
      disposed = true;
      chart.off('datazoom', handleZoom);
      chart.getZr()?.off('dblclick', resetZoom);
      if (onSelect) chart.getZr()?.off('click', selectPoint);
      if (onHover) {
        chart.getZr()?.off('mousemove', hoverPoint);
        chart.getZr()?.off('globalout', clearHover);
      }
      chart.dispose();
    }
  };
}
