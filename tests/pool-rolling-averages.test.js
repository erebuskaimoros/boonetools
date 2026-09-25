import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildPoolAnalysisOption } from '../src/lib/pool-analysis/charts.js';
import { POOL_ROLLING_AVERAGES, buildPoolRollingAverages, mergePoolRollingHistory } from '../src/lib/pool-analysis/rolling-averages.js';
import { createTimeSeriesController } from '../src/lib/charts/controller.js';
import { utcDayZoomWindow } from '../src/lib/charts/viewport.js';

const dailyRows = (length = 120) => Array.from({ length }, (_, i) => ({
  day: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  volumeUsd: i * 100, feesUsd: i, cumulativeFeesUsd: i * (i + 1) / 2
}));
const ids = POOL_ROLLING_AVERAGES.map((option) => option.id);

test('six independent rolling averages use trailing 7/30/90 calendar days, including real zeros', () => {
  assert.deepEqual(ids, ['volume-7d', 'volume-30d', 'volume-90d', 'fees-7d', 'fees-30d', 'fees-90d']);
  const rows = Object.freeze(dailyRows().map(Object.freeze));
  const values = buildPoolRollingAverages(rows, ids);
  for (const option of POOL_ROLLING_AVERAGES) {
    assert.equal(values.get(rows[option.days - 2].day)[option.id].value, null);
    assert.equal(values.get(rows[option.days - 1].day)[option.id].value, (option.days - 1) / 2 * (option.axis === 'volume' ? 100 : 1));
    assert.equal(values.get(rows[119].day)[option.id].value, (119 - (option.days - 1) / 2) * (option.axis === 'volume' ? 100 : 1));
  }
});

test('missing, nonfinite and absent calendar days leave gaps and recover after a full window', () => {
  for (const missing of [null, undefined, NaN, Infinity]) {
    const rows = dailyRows(20);
    rows[7].feesUsd = missing;
    const values = buildPoolRollingAverages(rows, ['fees-7d', 'volume-7d']);
    assert.equal(values.get(rows[13].day)['fees-7d'].value, null);
    assert.equal(values.get(rows[14].day)['fees-7d'].value, 11);
    assert.equal(values.get(rows[13].day)['volume-7d'].value, 1000);
  }
  const rows = dailyRows(20);
  const missingDay = rows[7].day;
  const values = buildPoolRollingAverages(rows.filter((row) => row.day !== missingDay), ['fees-7d']);
  assert.equal(values.get(rows[13].day)['fees-7d'].value, null);
  assert.equal(values.get(rows[14].day)['fees-7d'].value, 11);
  rows[7].source = 'missing';
  assert.equal(buildPoolRollingAverages(rows, ['fees-7d']).get(rows[13].day)['fees-7d'].value, null);
});

test('fresh visible rows override cached history, including nulls; duplicate dates are counted once', () => {
  const history = dailyRows(10);
  const current = [{ ...history[8], volumeUsd: null }, { ...history[9], feesUsd: 0, partial: true }];
  const merged = mergePoolRollingHistory([...history].reverse(), current);
  assert.equal(merged.length, 10);
  assert.equal(history[9].feesUsd, 9);
  const values = buildPoolRollingAverages(merged, ['fees-7d', 'volume-7d']).get(history[9].day);
  assert.equal(values['volume-7d'].value, null);
  assert.equal(values['fees-7d'].value, 33 / 7);
  assert.equal(values['fees-7d'].partial, true);
});

test('averages use off-screen lookback without changing the 30D plot or selected zoom', () => {
  const history = dailyRows();
  const visible = history.slice(-30);
  const window = { startDay: visible[5].day, endDay: visible[20].day };
  const original = buildPoolAnalysisOption(visible, { window });
  const option = buildPoolAnalysisOption(visible, { window, rollingAverages: ids, rollingHistory: history });
  assert.deepEqual(option.xAxis, original.xAxis);
  assert.deepEqual(option.dataZoom, original.dataZoom);
  assert.deepEqual(option.series.slice(0, 3), original.series);
  assert.equal(option.series.length, 9);
  assert.equal(option.series.find((s) => s.id === 'fees-90d').data[0], 45.5);
  assert.deepEqual(option.series.slice(3).map((s) => s.lineStyle.type), ['solid', 'dashed', 'dotted', 'solid', 'dashed', 'dotted']);
  assert.ok(option.series.slice(3).every((s) => !s.connectNulls && !s.smooth));
  assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /90D AVG FEES: \$45.50/);
});

test('average overlays remain visible independently of bars and keep only the necessary axes', () => {
  const rows = dailyRows();
  const option = buildPoolAnalysisOption(rows, { hidden: ['volume', 'fees', 'line'], rollingAverages: ['volume-7d'] });
  assert.ok(option.series.slice(0, 3).every((s) => s.data.length === 0));
  assert.deepEqual(option.yAxis.map((axis) => axis.show), [true, false, false]);
  assert.equal(option.series[3].yAxisIndex, 0);
  assert.equal(option.series[3].data[6], 300);
  assert.match(option.tooltip.formatter([{ dataIndex: 6 }]), /data-series="volume-7d"/);
  assert.doesNotMatch(option.tooltip.formatter([{ dataIndex: 6 }]), /data-series="volume"/);
  const cleared = buildPoolAnalysisOption(rows, { hidden: ['volume', 'fees', 'line'] });
  assert.equal(cleared.series.length, 3);
  assert.ok(cleared.yAxis.every((axis) => !axis.show));
});

test('partial windows are labeled without extrapolation and missing warmup remains unavailable', () => {
  const rows = dailyRows(10);
  rows[9].partial = true;
  const option = buildPoolAnalysisOption(rows, { rollingAverages: ['fees-7d', 'fees-30d'] });
  assert.equal(option.series[3].data[9], 6);
  assert.match(option.tooltip.formatter([{ dataIndex: 9 }]), /7D AVG FEES: \$6.00 · PARTIAL WINDOW/);
  assert.match(option.tooltip.formatter([{ dataIndex: 9 }]), /30D AVG FEES: unavailable/);
  assert.equal(buildPoolAnalysisOption([], { rollingAverages: ids }).series.length, 9);
});

test('Pool rolling menu is multi-select and history loading never replaces the selected chart range', async () => {
  const source = await readFile(new URL('../src/lib/PoolAnalysis.svelte', import.meta.url), 'utf8');
  const menu = await readFile(new URL('../src/lib/charts/ChartTools.svelte', import.meta.url), 'utf8');
  assert.match(menu, /type="checkbox" checked=\{rolling.includes/);
  assert.match(menu, /event.key === 'Escape'/);
  assert.match(source, /onRollingChange=\{/);
  const loader = source.slice(source.indexOf('async function loadRollingHistory'), source.indexOf('function resetZoom'));
  assert.match(loader, /fetchPoolAnalysisSeries\(asset, 'all'/);
  assert.match(loader, /sequence !== rollingSequence \|\| asset !== selectedAsset/);
  assert.doesNotMatch(loader, /(?:selectedSeries|rangeId|zoomWindow)\s*=/);
});

test('real ECharts adds and removes all six overlays while retaining UTC zoom and correct axes', async () => {
  const { init, use } = await import('echarts/core');
  const { BarChart, LineChart } = await import('echarts/charts');
  const { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } = await import('echarts/components');
  const { SVGRenderer } = await import('echarts/renderers');
  use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
  const history = dailyRows();
  const points = history.slice(-30);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 490 });
  const controller = createTimeSeriesController(chart, { points, options: {} }, { buildOption: buildPoolAnalysisOption, width: () => 1000 });
  try {
    chart.dispatchAction({ type: 'dataZoom', dataZoomId: chart.getOption().dataZoom[0].id, startValue: 5, endValue: 20 });
    const window = { startDay: points[5].day, endDay: points[20].day };
    for (const rollingAverages of [ids, ['fees-90d'], []]) {
      controller.update({ points, options: { rollingAverages, rollingHistory: history, hidden: ['volume'] } });
      const option = chart.getOption();
      assert.deepEqual(utcDayZoomWindow(points, option.dataZoom[0]), window);
      const rendered = option.series.filter(Boolean);
      assert.deepEqual(rendered.map((s) => s.id).sort(), ['volume', 'fees', 'line', ...rollingAverages].sort());
      assert.equal(option.yAxis[0].show, rollingAverages.some((id) => id.startsWith('volume')));
      assert.match(chart.renderToSVGString(), /<svg/);
    }
  } finally { controller.destroy(); }
});
