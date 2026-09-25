import assert from 'node:assert/strict';
import test from 'node:test';
import { utcDayIndices, utcDayWindow, utcDayZoomWindow, zoomUtcDayWindow } from '../src/lib/charts/viewport.js';
import { timeSeriesTooltip } from '../src/lib/charts/time-series.js';
import { createTimeSeriesController } from '../src/lib/charts/controller.js';
import { buildBurnTrackerOption, burnTrackerTooltip, BURN_BAR_COLOR } from '../src/lib/burn-tracker/charts.js';
import { normalizeBurnTrackerPayload, selectBurnTrackerRange } from '../src/lib/burn-tracker/model.js';
import { buildPoolAnalysisOption, poolAnalysisTooltip } from '../src/lib/pool-analysis/charts.js';
import { buildFinancialEChartsOption } from '../src/lib/financials/echarts-options.js';

const rows = Array.from({ length: 10 }, (_, index) => Object.freeze({
  day: `2026-09-${String(index + 1).padStart(2, '0')}`,
  burnedRune: index, burnedUsd: index * 2, cumulativeBurnedRune: 100 + index, cumulativeBurnedUsd: 200 + index * 2,
  runePriceUsd: index === 2 ? null : 2,
  volumeUsd: index === 1 ? null : index * 100, feesUsd: index, cumulativeFeesUsd: 100 + index,
  volumeRuneBase: '100000000', feesRuneBase: '1000000', feesRune: 0.01,
  depthUsd: index === 1 ? null : 500 + index,
  incomeUsd: index, bondingApr: index === 1 ? null : 3,
  blockRewardsRune: 1, bondingEarningsRune: 1, activeBondRune: 100,
  partial: index === 9, through: Date.parse('2026-09-10T12:00:00Z') / 1000
}));
Object.freeze(rows);

test('UTC viewport bounds clamp to observations, keep zeros, and handle sparse/empty/single-day data', () => {
  assert.deepEqual(utcDayIndices([], null), { start: 0, end: 0 });
  assert.equal(utcDayWindow([], 0, 0), null);
  assert.equal(utcDayWindow([rows[0]], 0, 0), null);
  assert.equal(utcDayWindow(rows, NaN, 1), null);
  assert.equal(utcDayWindow(rows, -10, 20), null);
  const window = { startDay: rows[1].day, endDay: rows[8].day };
  assert.deepEqual(utcDayWindow(rows, 0.2, 8.9), window);
  assert.deepEqual(utcDayZoomWindow(rows, { startValue: rows[1].day, endValue: rows[8].day }), window);
  assert.deepEqual(utcDayZoomWindow(rows, { start: 10, end: 90 }), window);
  assert.deepEqual(utcDayIndices([rows[0], rows[3], rows[8]], window), { start: 1, end: 2 });
  assert.deepEqual(utcDayIndices(rows, { startDay: '2027-01-01', endDay: '2027-01-10' }), { start: 0, end: 9 });
  assert.equal(zoomUtcDayWindow(rows, window, 20), null);
  assert.deepEqual(zoomUtcDayWindow(rows, null, 0.4), { startDay: rows[3].day, endDay: rows[6].day });
  assert.deepEqual(zoomUtcDayWindow(rows, window, -1), window);
});

test('shared tooltip escapes text/metadata and renders square series swatches', () => {
  const html = timeSeriesTooltip(['<img src=x onerror=alert(1)>', {
    id: 'safe', color: '#5588cc', fill: 'rgba(85,136,204,0.3)', text: 'Volume: <script> & "value"'
  }]);
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;script&gt; &amp; &quot;value&quot;/);
  assert.match(html, /data-series="safe"/);
  assert.match(html, /border-radius:0/);
});

test('Burn keeps orange daily bars, all-time cumulative values, gaps, partial styling and the optional third axis', () => {
  const option = buildBurnTrackerOption(rows);
  assert.deepEqual(option.series[0].data, rows.map((row) => row.burnedRune));
  assert.equal(option.series[0].data[0], 0);
  assert.equal(option.series[0].itemStyle.borderColor, BURN_BAR_COLOR);
  assert.notEqual(option.series[0].itemStyle.color({ dataIndex: 0 }), option.series[0].itemStyle.color({ dataIndex: 9 }));
  assert.deepEqual(option.series[1].data, rows.map((row) => row.cumulativeBurnedRune));
  assert.equal(option.yAxis[1].scale, true);
  assert.equal(option.yAxis[2].show, false);
  assert.deepEqual(option.series[2].data, []);
  const visiblePrice = buildBurnTrackerOption(rows, { unit: 'usd', hidden: [] });
  assert.deepEqual(visiblePrice.series[0].data, rows.map((row) => row.burnedUsd));
  assert.deepEqual(visiblePrice.series[1].data, rows.map((row) => row.cumulativeBurnedUsd));
  assert.equal(visiblePrice.series[2].data[2], null);
  assert.equal(visiblePrice.series[2].connectNulls, false);
  assert.equal(visiblePrice.series[2].lineStyle.type, 'dashed');
  assert.equal(visiblePrice.yAxis[2].offset, 86);
  assert.equal(buildBurnTrackerOption(rows, { hidden: ['cumulative'] }).yAxis[2].offset, 0);
  assert.match(burnTrackerTooltip(rows[9], { unit: 'usd', hidden: [] }), /DAILY BURN: \$18.00/);
  assert.match(burnTrackerTooltip(rows[9]), /LIVE PARTIAL UTC DAY/);
  assert.doesNotMatch(burnTrackerTooltip(rows[9]), /data-series="price"/);
});

test('Burn model baseline survives preset slicing and custom chart zoom in both currencies', () => {
  const daily = Array.from({ length: 200 }, (_, index) => ({
    day: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    burn_e8: '100000000', cumulative_burn_e8: String((1000 + index) * 1e8), rune_price_usd: 2
  }));
  const selected = selectBurnTrackerRange(normalizeBurnTrackerPayload({ daily }).daily, '30d');
  const window = { startDay: selected[10].day, endDay: selected[20].day };
  for (const unit of ['rune', 'usd']) {
    const option = buildBurnTrackerOption(selected, { unit, window });
    assert.equal(option.series[1].data[0], unit === 'usd' ? 342 : 1170);
    assert.equal(option.dataZoom[0].startValue, 10);
    assert.equal(option.dataZoom[0].endValue, 20);
  }
});

test('Pool line selection preserves bars/window and exposes exact fees, missing depth and provenance', () => {
  const window = { startDay: rows[2].day, endDay: rows[6].day };
  const fees = buildPoolAnalysisOption(rows, { window });
  const depth = buildPoolAnalysisOption(rows, { window, lineMetric: 'depth' });
  assert.deepEqual(depth.series.slice(0, 2), fees.series.slice(0, 2));
  assert.deepEqual(depth.dataZoom, fees.dataZoom);
  assert.equal(depth.series[2].name, 'DEPTH');
  assert.deepEqual(depth.series[2].data, rows.map((row) => row.depthUsd));
  assert.equal(depth.series[2].connectNulls, false);
  assert.equal(depth.yAxis[2].name, 'DEPTH · USD');
  assert.equal(depth.series[0].barMaxWidth, undefined);
  assert.match(poolAnalysisTooltip(rows[1], 'depth'), /DEPTH: unavailable/);
  assert.match(poolAnalysisTooltip(rows[0]), /FEES \/ VOLUME: 100 BPS/);
  assert.match(poolAnalysisTooltip(rows[0]), /CUMULATIVE FEES: \$100.00/);
  const detail = poolAnalysisTooltip({ ...rows[1], source: 'missing', depthPartial: true, depthUpdatedAt: '<untrusted>' }, 'depth');
  assert.match(detail, /MISSING SOURCE DAY/);
  assert.match(detail, /LIVE PARTIAL UTC DAY/);
  assert.match(detail, /DEPTH OBSERVED: &lt;untrusted&gt;/);
  assert.equal((detail.match(/data-series=/g) || []).length, 3);
});

test('all three adapters use readable responsive axes, no wheel hijacking, and empty-safe options', () => {
  for (const build of [buildFinancialEChartsOption, buildBurnTrackerOption, buildPoolAnalysisOption]) {
    const option = build(rows, { width: 340, hidden: [] });
    assert.ok(option.yAxis.every((axis) => axis.name === '' && axis.axisLabel.fontSize >= 11));
    assert.ok(option.grid.left + option.grid.right < 250);
    assert.ok(option.tooltip.textStyle.fontSize >= 12);
    assert.equal(option.dataZoom[0].zoomOnMouseWheel, false);
    assert.equal(option.animation, false);
    const empty = build([]);
    assert.deepEqual(empty.xAxis.data, []);
    assert.equal(empty.dataZoom[0].minValueSpan, 0);
    assert.equal(empty.tooltip.formatter([]), '');
  }
});

test('real ECharts controller keeps UTC zoom across updates, metric switches, visibility and resize; reset follows latest', async () => {
  const { init, use } = await import('echarts/core');
  const { BarChart, LineChart } = await import('echarts/charts');
  const { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } = await import('echarts/components');
  const { SVGRenderer } = await import('echarts/renderers');
  use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
  for (const buildOption of [buildFinancialEChartsOption, buildBurnTrackerOption, buildPoolAnalysisOption]) {
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 430 });
    let reported;
    let width = 1000;
    const controller = createTimeSeriesController(chart, { points: rows, window: null, options: {} }, {
      buildOption, width: () => width, onZoom: (window) => { reported = window; }
    });
    try {
      const zoomId = chart.getOption().dataZoom[0].id;
      chart.dispatchAction({ type: 'dataZoom', dataZoomId: zoomId, startValue: 2, endValue: 6 });
      const window = { startDay: rows[2].day, endDay: rows[6].day };
      assert.deepEqual(reported, window);
      const updated = [...rows, { ...rows[9], day: '2026-09-11' }];
      controller.update({ points: updated, options: { lineMetric: 'depth', hidden: [], unit: 'usd' } });
      const readWindow = () => utcDayZoomWindow(updated, chart.getOption().dataZoom[0]);
      assert.deepEqual(readWindow(), window);
      width = 340;
      controller.resize();
      assert.deepEqual(readWindow(), window);
      assert.ok(chart.getOption().yAxis.every((axis) => axis.name === ''));
      controller.zoomBy(0.6);
      assert.ok(reported.startDay >= window.startDay && reported.endDay <= window.endDay);
      controller.resetZoom();
      assert.equal(reported, null);
      assert.equal(readWindow(), null);
      controller.update({ points: updated, options: {}, window });
      assert.deepEqual(readWindow(), window);
      chart.getZr().trigger('dblclick', {});
      assert.equal(readWindow(), null);
      controller.update({ points: rows.slice(3), options: {}, window });
      assert.deepEqual(reported, { startDay: rows[3].day, endDay: rows[6].day });
      controller.update({ points: rows.slice(7), options: {}, window });
      assert.equal(reported, null);
      assert.match(chart.renderToSVGString(), /<svg/);
    } finally { controller.destroy(); controller.destroy(); }
    assert.equal(chart.isDisposed(), true);
  }
});

test('controller cleans up initialization failures and ignores work after disposal', () => {
  let disposals = 0, renders = 0, resizes = 0;
  const zr = { on() {}, off() {} };
  const chart = { on() {}, off() {}, getZr: () => zr, setOption() { renders++; },
    dispatchAction() {}, dispose() { disposals++; }, resize() { resizes++; } };
  assert.throws(() => createTimeSeriesController(chart, { points: [] }, {
    buildOption() { throw new Error('fixture failure'); }, width: () => 100
  }), /fixture failure/);
  assert.equal(disposals, 1);
  const controller = createTimeSeriesController(chart, { points: rows }, { buildOption: buildPoolAnalysisOption, width: () => 1000 });
  controller.destroy(); controller.destroy();
  controller.update({ points: rows }); controller.resize(); controller.resetZoom();
  assert.equal(disposals, 2);
  assert.equal(renders, 1);
  assert.equal(resizes, 0);
});
