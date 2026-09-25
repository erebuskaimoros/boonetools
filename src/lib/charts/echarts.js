import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, MarkPointComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { createTimeSeriesController } from './controller.js';

use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, MarkPointComponent, ToolboxComponent, TooltipComponent, CanvasRenderer]);

export function createTimeSeriesChart(container, initial, options) {
  return createTimeSeriesController(init(container, null, { renderer: 'canvas' }), initial, {
    ...options, width: () => container.clientWidth
  });
}
