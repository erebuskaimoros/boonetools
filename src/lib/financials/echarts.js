import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { buildFinancialEChartsOption, financialEChartsWindow } from './echarts-options.js';

use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, CanvasRenderer]);

export function createFinancialECharts(container, initial, onZoom = (_window) => {}) {
  const chart = init(container, null, { renderer: 'canvas' });
  let state = initial;
  let disposed = false;

  function render() {
    if (disposed) return;
    chart.setOption(buildFinancialEChartsOption(state.points, {
      currency: state.currency, hidden: state.hidden, window: state.window,
      width: container.clientWidth
    }), { replaceMerge: ['series'], silent: true });
    // ECharts' native marquee selector handles drag-to-zoom. The toolbox also
    // exposes selection/undo; the shared HTML reset remains keyboard accessible.
    chart.dispatchAction({
      type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: true
    }, { silent: true });
  }

  chart.on('datazoom', () => {
    if (disposed) return;
    const zooms = chart.getOption().dataZoom;
    const zoom = Array.isArray(zooms) ? zooms.find((item) => item.id === 'financials-window') : null;
    const window = financialEChartsWindow(state.points, zoom);
    state = { ...state, window };
    onZoom(window);
  });

  try { render(); }
  catch (error) { chart.dispose(); throw error; }

  return {
    update(next) { state = next; render(); },
    resize() { if (!disposed) { chart.resize(); render(); } },
    destroy() { disposed = true; chart.dispose(); }
  };
}
