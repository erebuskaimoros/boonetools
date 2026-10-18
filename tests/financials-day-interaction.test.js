import assert from 'node:assert/strict';
import test from 'node:test';
import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { createTimeSeriesController } from '../src/lib/charts/controller.js';
import { buildFinancialEChartsOption, financialEChartsTooltip } from '../src/lib/financials/echarts-options.js';
import { utcDayZoomWindow } from '../src/lib/charts/viewport.js';
use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
const rows = Array.from({ length: 6 }, (_, i) => ({ day: `2026-10-${12 + i}`, volumeUsd: 100 + i, volumeRune: 200 + i,
  incomeUsd: 10, incomeRune: 20, bondingApr: i + 1, runePriceUsd: i === 2 ? null : .5 + i / 100,
  partial: i === 5, through: Date.parse('2026-10-17T12:00:00Z') / 1000 }));

test('price is the default third axis and stays USD under the RUNE denomination', () => {
  for (const currency of ['usd', 'rune']) {
    const option = buildFinancialEChartsOption(rows, { currency });
    assert.deepEqual(option.yAxis.map(axis => axis.id), ['volume', 'income', 'runePriceUsd']);
    assert.equal(option.yAxis[2].name, 'RUNE PRICE · USD');
    assert.deepEqual(option.series[2].data, [.5, .51, null, .53, .54, null]);
    assert.deepEqual(option.series[3].data, [null, null, null, null, .54, .55]);
    assert.equal(option.series[3].lineStyle.type, 'dashed');
    const text = financialEChartsTooltip(rows[0], currency);
    assert.match(text, /RUNE PRICE: \$0.5/);
    assert.doesNotMatch(text, /BONDING APR:/);
  }
});

test('weekly and monthly price use the closing observation, never the sum or mean', () => {
  for (const grain of ['week', 'month']) {
    const option = buildFinancialEChartsOption(rows, { analysis: { grain } });
    assert.equal(option.series[2].data[0], .55);
    assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /RUNE PRICE: \$0.55/);
    const missingClose = rows.map((row, i) => i === 5 ? { ...row, runePriceUsd: null } : row);
    assert.equal(buildFinancialEChartsOption(missingClose, { analysis: { grain } }).series[2].data[0], null);
  }
});

test('a zoomable Financials plot selects a clicked day, ignores drags/outside clicks, and preserves zoom on metric changes', () => {
  let selected = null;
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1100, height: 430 });
  const controller = createTimeSeriesController(chart, { points: rows, options: { selectWithZoom: true } }, {
    buildOption: buildFinancialEChartsOption, width: () => 1100, onSelect: day => { selected = day; }
  });
  try {
    const trigger = (name, x, y = 80) => chart.getZr().trigger(name, { offsetX: x, offsetY: y, event: { preventDefault() {}, stopPropagation() {} } });
    const x = chart.convertToPixel({ xAxisIndex: 0 }, 1);
    trigger('mousedown', x); trigger('mouseup', x); trigger('click', x);
    assert.equal(selected, rows[1].day);
    selected = null;
    trigger('mousedown', x); trigger('mousemove', x + 30); trigger('mouseup', x + 30); trigger('click', x + 30);
    assert.equal(selected, null);
    trigger('mousedown', 0, 0); trigger('mouseup', 0, 0); trigger('click', 0, 0);
    assert.equal(selected, null);
    chart.dispatchAction({ type: 'dataZoom', startValue: 1, endValue: 4 });
    const window = { startDay: rows[1].day, endDay: rows[4].day };
    controller.update({ points: rows, options: { lineMetric: 'bondingApr', selectWithZoom: true } });
    assert.deepEqual(utcDayZoomWindow(rows, chart.getOption().dataZoom[0]), window);
    assert.equal(chart.getOption().yAxis[2].id, 'bondingApr');
    controller.update({ points: rows, options: { lineMetric: 'runePriceUsd', selectWithZoom: true } });
    assert.deepEqual(utcDayZoomWindow(rows, chart.getOption().dataZoom[0]), window);
    assert.equal(chart.getOption().yAxis[2].id, 'runePriceUsd');
  } finally { controller.destroy(); }
});
