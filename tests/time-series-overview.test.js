import assert from 'node:assert/strict';
import test from 'node:test';
import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, MarkPointComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { buildTimeSeriesOption } from '../src/lib/charts/time-series.js';
import { analysisLegend } from '../src/lib/charts/analytics.js';
import { createTimeSeriesController } from '../src/lib/charts/controller.js';
import { utcDayZoomWindow } from '../src/lib/charts/viewport.js';
import { computeDailyBucketData } from '../src/lib/rapid-swaps/charts.js';
import { buildRapidSwapOverviewOption, rapidSwapOverviewPoints, rapidSwapOverviewTooltip } from '../src/lib/rapid-swaps/overview-charts.js';
import { buildSystemIncomePolChart, buildSystemIncomePolFeeChart, normalizeSystemIncomePolPayload, applySystemIncomePolHead } from '../src/lib/system-income-pol/model.js';
import { buildSystemIncomePolDepositOption, buildSystemIncomePolFeeOption, polDepositTooltip, polFeeTooltip } from '../src/lib/system-income-pol/charts.js';

use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, MarkPointComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);

const rapidData = computeDailyBucketData([
  { bucket_start: '2026-09-01T00:00:00Z', leg_volume_usd: 40, swap_count: 2, total_subs: 4, total_blocks_used: 2 },
  { bucket_start: '2026-09-02T00:00:00Z', leg_volume_usd: 60, swap_count: 3, total_subs: 8, total_blocks_used: 2 }
], { intervals: [{ startTime: Date.parse('2026-09-01T00:00:00Z') / 1000, totalVolumeUSD: 10000, totalCount: 20 }] },
{ cumulativeVolumeBefore: 1000, cumulativeCountBefore: 100 });
const rapidPoints = rapidSwapOverviewPoints(rapidData).map(Object.freeze);

test('six Rapid overview adapters preserve all seeded values, axes, legends, gaps and calendar identity', () => {
  assert.deepEqual(rapidData.days, ['2026-09-01', '2026-09-02']);
  assert.equal(rapidData.calendar, 'UTC');
  for (const metric of ['volume', 'count', 'efficiency', 'pctFaster', 'volumePct', 'countPct']) {
    const option = buildRapidSwapOverviewOption(rapidPoints, { metric, width: 340 });
    assert.deepEqual(option.xAxis.data, rapidData.days);
    assert.deepEqual(option.series[0].data, rapidData[metric]);
    assert.deepEqual(option.dataZoom, []);
    assert.deepEqual(option.toolbox.feature, {});
    assert.equal(option.toolbox.show, false);
    assert.equal(option.animation, false);
    assert.ok(option.yAxis.every(axis => axis.axisLabel.fontSize >= 11));
    assert.ok(option.grid.left + option.grid.right < 150);
    assert.match(rapidSwapOverviewTooltip(rapidPoints[0], { metric }), /data-series=/);
    assert.deepEqual(buildRapidSwapOverviewOption([], { metric }).xAxis.data, []);
  }
  const volume = buildRapidSwapOverviewOption(rapidPoints);
  assert.deepEqual(volume.series[1].data, [1040, 1100]);
  assert.ok(volume.yAxis[1].min > 1000);
  assert.equal(buildRapidSwapOverviewOption(rapidPoints, { metric: 'count' }).yAxis[1].minInterval, 1);
  const hidden = buildRapidSwapOverviewOption(rapidPoints, { hidden: ['cumVolume'] });
  assert.deepEqual(hidden.series[1].data, []);
  assert.equal(hidden.yAxis[1].show, false);
  assert.doesNotMatch(rapidSwapOverviewTooltip(rapidPoints[0], { hidden: ['cumVolume'] }), /CUMULATIVE/);
  assert.match(rapidSwapOverviewTooltip(rapidPoints[1], { metric: 'volumePct' }), /unavailable/);
  assert.match(rapidSwapOverviewTooltip({ ...rapidPoints[0], calendar: 'local' }), /LOCAL DAY/);
});

test('shared filled lines keep gaps and adapters explicitly own axis bounds', () => {
  const rows = [...rapidPoints, { ...rapidPoints[1], day: '2026-09-03', efficiency: null }];
  const option = buildRapidSwapOverviewOption(rows, { metric: 'efficiency' });
  assert.ok(option.series[0].areaStyle.color);
  assert.equal(option.series[0].smooth, 0.3);
  assert.equal(option.series[0].data[2], null);
  assert.equal(option.series[0].connectNulls, false);
  assert.equal(option.yAxis[0].scale, true);
  const bounded = buildTimeSeriesOption([], { axes: [{ id: 'x', min: -5, max: 5, integer: true }], series: [], tooltip: () => '' });
  assert.equal(bounded.yAxis[0].min, -5);
  assert.equal(bounded.yAxis[0].max, 5);
});

const polPayload = {
  live: { through_height: 10 },
  daily: [
    { day: '2026-09-01', deployed_e8: '200000000', cumulative_deployed_e8: '10000000000', estimated_fees_e8: '100000000', rune_price_usd: '2' },
    { day: '2026-09-02', deployed_e8: '300000000', cumulative_deployed_e8: '10300000000', estimated_fees_e8: '200000000' },
    { day: '2026-09-03', deployed_e8: '0', cumulative_deployed_e8: '10300000000', estimated_fees_e8: '0' },
    { day: '2026-09-04', deployed_e8: '500000000', cumulative_deployed_e8: '10800000000', estimated_fees_e8: '300000000', rune_price_usd: '4', partial: true, price_provisional: true, fee_coverage: { total_hours: 10, covered_hours: 8, seeded_hours: 1, provisional_hours: 1 } },
    { day: '2026-09-05', deployed_e8: '0', cumulative_deployed_e8: '10800000000', estimated_fees_e8: null, rune_price_usd: '5' }
  ]
};
const polDaily = normalizeSystemIncomePolPayload(polPayload).daily;

test('POL deposits keep separate zero-based axes, exact all-time RUNE and incomplete cumulative dollars', () => {
  const runePoints = buildSystemIncomePolChart(polDaily).points;
  const usdPoints = buildSystemIncomePolChart(polDaily, { unit: 'usd' }).points;
  const rune = buildSystemIncomePolDepositOption(runePoints);
  const usd = buildSystemIncomePolDepositOption(usdPoints, { unit: 'usd' });
  assert.deepEqual(rune.series.map(series => series.data), [[2, 3, 0, 5, 0], [100, 103, 103, 108, 108]]);
  assert.deepEqual(usd.series.map(series => series.data), [[4, null, 0, 20, 0], [4, null, null, null, null]]);
  assert.ok(usd.yAxis.every(axis => axis.min === 0));
  assert.equal(usd.series[1].connectNulls, false);
  assert.match(polDepositTooltip(usdPoints[3], 'usd'), /PROVISIONAL/);
  assert.match(polDepositTooltip(usdPoints[3], 'usd'), /CUMULATIVE POL DEPOSITED: Unavailable/);
  assert.equal(buildSystemIncomePolDepositOption(runePoints.slice(3)).series[1].data[0], 108);
});

test('POL deposit rolling menu excludes cumulative totals without removing the cumulative plot or legend', () => {
  const points = Array.from({ length: 10 }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, '0')}`,
    depositedPlotValue: i + 1, cumulativeDepositedValue: 100 + (i + 1) * (i + 2) / 2
  }));
  for (const unit of ['rune', 'usd']) {
    const base = buildSystemIncomePolDepositOption(points, { unit });
    const legend = analysisLegend(base._spec.series);
    assert.deepEqual(legend.map(item => item.id), ['daily', 'cumulative']);
    assert.deepEqual(legend.filter(item => item.rolling !== false).map(item => item.id), ['daily']);
    for (const grain of ['day', 'week', 'month']) {
      const option = buildSystemIncomePolDepositOption(points, { unit, analysis: {
        grain, rolling: ['daily-7d', 'cumulative-7d', 'cumulative-30d', 'cumulative-90d']
      } });
      assert.deepEqual(option.series.map(item => item.id), ['daily', 'cumulative', 'daily-7d']);
      assert.equal(option.series.at(-1).data.at(-1), 7);
      assert.equal(option.series[1].data.at(-1), 155);
    }
  }
});

test('POL fee renderer annotates zero vs missing without fabricating bars and exposes coverage/provisional details', () => {
  const points = buildSystemIncomePolFeeChart(polDaily).points;
  const option = buildSystemIncomePolFeeOption(points);
  assert.deepEqual(option.series[0].data.map(datum => datum?.value ?? null), [2, null, 0, 12, null]);
  assert.equal(option.series[0].data[3].itemStyle.borderType, 'dashed');
  assert.equal(option.series[0].data[0].itemStyle.borderType, 'solid');
  assert.deepEqual(option.series[0].markPoint.data.map(marker => [marker.coord[0], marker.value]), [
    ['2026-09-02', '×'], ['2026-09-03', '—'], ['2026-09-05', '×']
  ]);
  assert.match(polFeeTooltip(points[1]), /Daily USD price unavailable/);
  assert.match(polFeeTooltip(points[4]), /Fee estimate unavailable/);
  assert.match(polFeeTooltip(points[3]), /8\/10 POOL-HOURS/);
  assert.match(polFeeTooltip(points[3]), /INCLUDES SEEDED OWNERSHIP/);
  assert.match(polFeeTooltip(points[3]), /PARTIAL \/ PROVISIONAL/);
  assert.equal(option.dataZoom.length, 0);
  assert.equal(buildSystemIncomePolFeeOption(points, { selectedDay: points[0].day }).tooltip.show, false);
  const allMissing = buildSystemIncomePolFeeOption([points[4]]);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 320, height: 240 });
  try {
    chart.setOption(allMissing);
    assert.match(chart.renderToSVGString(), /×/);
  } finally { chart.dispose(); }
});

test('real overview controller refreshes/resizes without adding zoom and selects known-zero or missing days', () => {
  for (const [buildOption, points] of [
    [buildRapidSwapOverviewOption, rapidPoints],
    [buildSystemIncomePolFeeOption, buildSystemIncomePolFeeChart(polDaily).points]
  ]) {
    let selected;
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 240 });
    const controller = createTimeSeriesController(chart, { points, options: {} }, {
      buildOption, width: () => 1000, onSelect: (day) => { selected = day; }
    });
    try {
      assert.equal(chart.getOption().dataZoom?.length ?? 0, 0);
      controller.zoomBy(0.5); controller.resetZoom();
      assert.equal(chart.getOption().dataZoom?.length ?? 0, 0);
      const pixel = chart.convertToPixel({ xAxisIndex: 0 }, 1);
      chart.getZr().trigger('click', { offsetX: pixel, offsetY: 80 });
      assert.equal(selected, points[1].day);
      chart.getZr().trigger('click', { offsetX: 0, offsetY: 0 });
      assert.equal(selected, points[1].day);
      controller.update({ points, options: { hidden: ['cumVolume'] } });
      controller.resize();
      assert.equal(chart.getOption().dataZoom?.length ?? 0, 0);
      assert.match(chart.renderToSVGString(), /<svg/);
    } finally { controller.destroy(); }
  }
});

test('live POL head and currency switch preserve a date-based viewport and cumulative anchors', () => {
  let unit = 'rune';
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 280 });
  let reported;
  const buildPoints = (payload) => buildSystemIncomePolChart(normalizeSystemIncomePolPayload(payload).daily, { unit }).points;
  const controller = createTimeSeriesController(chart, { points: buildPoints(polPayload), options: { unit } }, {
    buildOption: buildSystemIncomePolDepositOption, width: () => 1000, onZoom: window => { reported = window; }
  });
  try {
    chart.dispatchAction({ type: 'dataZoom', startValue: 1, endValue: 3 });
    const window = { startDay: '2026-09-02', endDay: '2026-09-04' };
    assert.deepEqual(reported, window);
    const next = applySystemIncomePolHead(polPayload, { height: 11, time: '2026-09-06T00:00:01Z',
      pol_reserve_deployments: [{ asset: 'TRON.USDT', rune_e8: '100000000' }] });
    let points = buildPoints(next);
    controller.update({ points, options: { unit } });
    assert.deepEqual(utcDayZoomWindow(points, chart.getOption().dataZoom[0]), window);
    assert.equal(chart.getOption().series[1].data[0], 100);
    unit = 'usd'; points = buildPoints(next);
    controller.update({ points, options: { unit } });
    assert.deepEqual(utcDayZoomWindow(points, chart.getOption().dataZoom[0]), window);
    assert.equal(chart.getOption().series[0].data.at(-1), null);
    controller.resetZoom();
    assert.equal(reported, null);
  } finally { controller.destroy(); }
});
