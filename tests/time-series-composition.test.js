import test from 'node:test';
import assert from 'node:assert/strict';
import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { createTimeSeriesController } from '../src/lib/charts/controller.js';
import { utcDayZoomWindow } from '../src/lib/charts/viewport.js';
import { APP_LAYER_CHARTS, appLayerPresetWindow, appLayerTooltip, buildAppLayerOption, prepareAppLayerChart } from '../src/lib/app-layer/charts.js';
import { buildPolTrackerOption, polTrackerTooltip } from '../src/lib/pol-tracker/charts.js';

use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
const appRows = Array.from({ length: 90 }, (_, index) => Object.freeze({
  bucket_start: new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10),
  accrued_value_usd: index + 3, inflow_usd: index - 2, liquidity_fee_usd: 5,
  payment_usd: index, pol_accrued_usd: index / 3,
  cumulative_usd: 1000 + index, cumulative_pol_accrued_usd: 200 + index
}));
const polRows = [0, 0, 5, 10, 0, 8, 9, null, 3, 4, 0].map((value, index) => Object.freeze({
  day: '2026-08-' + String(index + 1).padStart(2, '0'),
  synthBackingUsd: 100, treasuryTotalUsd: 20, reservePolUsd: 10, systemIncomePolUsd: value
}));
const makeChart = () => init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 320 });

test('all five App Layer adapters retain periodic values and full-history cumulative anchors across presets', () => {
  for (const [key, config] of Object.entries(APP_LAYER_CHARTS)) {
    const points = prepareAppLayerChart({ rows: Object.freeze(appRows), grain: 'daily' }, key);
    const window = appLayerPresetWindow(points);
    const bars = buildAppLayerOption(points, { key, window });
    const cumulative = buildAppLayerOption(points, { key, view: 'cumulative', window });
    assert.equal(bars.dataZoom[0].startValue, 60);
    assert.deepEqual(cumulative.dataZoom, bars.dataZoom);
    assert.deepEqual(cumulative.series[0].data, appRows.map(row => row[config.cumulativeField]));
    assert.equal(cumulative.series.length, 1);
    assert.equal(cumulative.series[0].type, 'line');
    assert.ok(cumulative.series[0].areaStyle);
    assert.equal(cumulative.yAxis[0].scale, true);
    assert.equal(bars.yAxis[0].min({ min: -5 }), -5.25);
    assert.equal(bars.yAxis[0].min({ min: 5 }), 0);
    assert.equal(appLayerPresetWindow(points, 'all'), null);
    assert.equal(buildAppLayerOption([], { key }).tooltip.formatter([]), '');
  }
  const points = prepareAppLayerChart({ rows: appRows, grain: 'daily' }, 'accrued');
  const bars = buildAppLayerOption(points);
  assert.deepEqual(bars.series.map(s => s.stack), ['app-value', 'app-value']);
  assert.deepEqual(bars.series[0].data, appRows.map(row => row.inflow_usd));
  assert.deepEqual(bars.series[1].data, appRows.map(row => row.liquidity_fee_usd));
  assert.deepEqual(buildAppLayerOption(points, { hidden: ['retained'] }).series[0].data, []);
});

test('App Layer alone fills activity gaps and carries cumulative baselines; weekly windows use overlapping UTC buckets', () => {
  for (const grain of ['daily', 'weekly']) {
    const step = grain === 'weekly' ? 7 : 1;
    const input = [appRows[0], appRows[step * 2]];
    const points = prepareAppLayerChart({ rows: input, grain }, 'accrued');
    assert.equal(points.length, 3);
    assert.equal(points[1].day, appRows[step].bucket_start);
    assert.equal(points[1].filledBucket, true);
    assert.equal(points[1].accrued_value_usd, 0);
    assert.equal(points[1].cumulative_usd, 1000);
    assert.equal(buildAppLayerOption(points).series[0].data[1], 0);
    assert.match(appLayerTooltip(points[1], { key: 'accrued', grain }), /cumulative carried forward/);
  }
  const weekly = prepareAppLayerChart({ rows: appRows.filter((_, i) => i % 7 === 0), grain: 'weekly' }, 'collected');
  assert.deepEqual(appLayerPresetWindow(weekly, '30d', 'weekly'), {
    startDay: appRows[56].bucket_start, endDay: appRows[84].bucket_start
  });
});

test('App Layer tooltip retains cutover/settlement/denom details, escapes metadata, and respects hidden components', () => {
  const row = { day: '2026-08-15', bucket_start: '2026-08-15', accrued_value_usd: 20,
    inflow_usd: 15, liquidity_fee_usd: 5, post_cutover_gross_usd: 45,
    payments: 2, payment_rune: 12, settlement_rune_price_usd: 3, cumulative_rune: 100,
    transfers: 1, by_denom: { '<untrusted>': { amount: -1, usd: -2 } } };
  const accrued = appLayerTooltip(row, { key: 'accrued', hidden: ['retained'] });
  assert.doesNotMatch(accrued, /data-series="retained"/);
  assert.match(accrued, /data-series="liquidity"/);
  assert.match(accrued, /TC-retained 01 \+ 03: \$20.00/);
  assert.match(appLayerTooltip(row, { key: 'pol', grain: 'weekly' }), /Post-cutover gross in this week: \$45.00/);
  assert.match(appLayerTooltip(row, { key: 'paid' }), /3 avg historical RUNE\/USD/);
  assert.match(appLayerTooltip(row, { key: 'paid' }), /2 Reserve deposits/);
  assert.doesNotMatch(appLayerTooltip(row, { key: 'collected' }), /<untrusted>/);
  assert.match(appLayerTooltip(row, { key: 'generated' }), /100 cumulative RUNE/);
});

test('real App Layer controller replaces stack/cumulative modes and resets to the latest preset, independently per chart', () => {
  const points = prepareAppLayerChart({ rows: appRows, grain: 'daily' }, 'accrued');
  const resetWindow = appLayerPresetWindow(points);
  const chart = makeChart(), otherChart = makeChart();
  let reported;
  const controller = createTimeSeriesController(chart, { points, window: resetWindow, resetWindow, options: {} },
    { buildOption: buildAppLayerOption, width: () => 1000, onZoom: window => reported = window });
  const other = createTimeSeriesController(otherChart, { points, window: resetWindow, resetWindow, options: { key: 'pol' } },
    { buildOption: buildAppLayerOption, width: () => 1000 });
  try {
    chart.dispatchAction({ type: 'dataZoom', startValue: 70, endValue: 80 });
    const custom = { startDay: points[70].day, endDay: points[80].day };
    assert.deepEqual(reported, custom);
    const appended = [...points, { ...points.at(-1), day: '2026-08-30', bucket_start: '2026-08-30' }];
    const nextPreset = appLayerPresetWindow(appended);
    controller.update({ points: appended, resetWindow: nextPreset, options: { view: 'cumulative' } });
    assert.equal(chart.getOption().series.length, 1);
    assert.deepEqual(utcDayZoomWindow(appended, chart.getOption().dataZoom[0]), custom);
    assert.deepEqual(utcDayZoomWindow(points, otherChart.getOption().dataZoom[0]), resetWindow);
    chart.getZr().trigger('dblclick', {});
    assert.deepEqual(reported, nextPreset);
    controller.update({ points: appended, options: {}, window: nextPreset, resetWindow: nextPreset });
    assert.equal(chart.getOption().series.length, 2);
    assert.match(chart.renderToSVGString(), /<svg/);
  } finally { controller.destroy(); other.destroy(); }
});

test('real POL area renderer breaks both fill and outline across zero/missing days, retaining correct stack bases', () => {
  const chart = makeChart();
  try {
    chart.setOption(buildPolTrackerOption(Object.freeze(polRows)));
    const svg = chart.renderToSVGString();
    const outline = svg.match(/<path d="([^"]*)"[^>]*stroke="#ff8a3d"/)?.[1];
    const area = svg.match(/<path d="([^"]*)"[^>]*fill="#ff8a3d57"/)?.[1];
    assert.equal((outline.match(/M/g) || []).length, 3);
    assert.equal((area.match(/Z/g) || []).length, 3);
    const data = chart.getModel().getSeriesByIndex(3).getData();
    const stacked = data.mapArray(data.getCalculationInfo('stackResultDimension'), value => value);
    assert.equal(stacked[2], 135);
    assert.equal(stacked[3], 140);
    assert.ok(Number.isNaN(stacked[4]));
    assert.ok(Number.isNaN(stacked[7]));
    chart.setOption(buildPolTrackerOption([
      { ...polRows[2], synthBackingUsd: 0 },
      { ...polRows[3], synthBackingUsd: null }
    ]), { notMerge: true });
    const top = chart.getModel().getSeriesByIndex(3).getData();
    assert.equal(top.get(top.getCalculationInfo('stackResultDimension'), 0), 35);
    assert.ok(Number.isNaN(top.get(top.getCalculationInfo('stackResultDimension'), 1)));
  } finally { chart.dispose(); }
  assert.match(polTrackerTooltip(polRows[0]), /SYSTEM INCOME POL: \$0/);
  assert.match(polTrackerTooltip(polRows[7]), /TOTAL: —/);
  assert.match(polTrackerTooltip({ ...polRows[7], complete: false }), /gaps are not zero/);
});

test('hover callback resolves original UTC day after zoom, clears on exit, and is removed on disposal', () => {
  const chart = makeChart();
  let hovered = 'unset';
  const controller = createTimeSeriesController(chart, { points: polRows, options: {}, window: null },
    { buildOption: buildPolTrackerOption, width: () => 1000, onHover: day => hovered = day });
  try {
    chart.dispatchAction({ type: 'dataZoom', startValue: 2, endValue: 7 });
    const x = chart.convertToPixel({ xAxisIndex: 0 }, 4);
    const y = chart.convertToPixel({ yAxisIndex: 0 }, 60);
    chart.getZr().trigger('mousemove', { offsetX: x, offsetY: y });
    assert.equal(hovered, polRows[4].day);
    chart.getZr().trigger('mousemove', { offsetX: 0, offsetY: 0 });
    assert.equal(hovered, null);
    chart.getZr().trigger('mousemove', { offsetX: x, offsetY: y });
    chart.getZr().trigger('globalout', {});
    assert.equal(hovered, null);
    const zr = chart.getZr();
    controller.destroy();
    hovered = 'unchanged';
    zr.trigger('mousemove', { offsetX: x, offsetY: y });
    assert.equal(hovered, 'unchanged');
  } finally { controller.destroy(); }
});
