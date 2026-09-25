import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarBounds, analyzeTimeSeries, rollingDailyValues, DAY_MS } from '../src/lib/charts/analytics.js';
import { eventCalendarDays, buildEventCalendarOption } from '../src/lib/charts/event-calendar.js';
import { buildTimeSeriesOption } from '../src/lib/charts/time-series.js';
import { createTimeSeriesController } from '../src/lib/charts/controller.js';
import { aggregateWasmArbEconomicsBuckets } from '../shared/wasm-arb-economics/model.js';
import { buildComparisonTimeSeries } from '../src/lib/protocol-fee-comparison/time-series.js';
import { buildComparisonPayload, emptyComparisonCache } from '../backend/src/protocol-fee-comparison/collector.js';

const rows = (n = 100) => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.UTC(2024, 0, 1) + i * DAY_MS).toISOString().slice(0, 10), value: i, balance: 1000 + i }));
const spec = points => ({ sourceGrain: 'day',
  axes: [{ id: 'flow', position: 'left' }, { id: 'stock', position: 'right' }],
  series: [
    { id: 'flow', label: 'FLOW', axis: 'flow', mark: 'bar', color: '#5588cc', aggregate: 'sum', data: points.map(row => row.value) },
    { id: 'stock', label: 'STOCK', axis: 'stock', mark: 'line', color: '#00cc66', aggregate: 'last', data: points.map(row => row.balance) }
  ] });
const builder = (points, options = {}) => buildTimeSeriesOption(points, { ...spec(points), tooltip: row => row.day, ...options });

test('UTC calendar boundaries use Monday weeks and real months, including leap February and year crossover', () => {
  assert.deepEqual(calendarBounds('2024-02-29', 'month'), { startDay: '2024-02-01', endDay: '2024-02-29', days: 29 });
  assert.deepEqual(calendarBounds('2023-01-01', 'week'), { startDay: '2022-12-26', endDay: '2023-01-01', days: 7 });
  assert.equal(calendarBounds('2024-03-10', 'day').days, 1);
});

test('flow totals, closing stocks, means and domain-weighted rates retain distinct accounting', () => {
  const points = rows(31), definition = spec(points);
  definition.series.push({ id: 'mean', aggregate: 'mean', data: points.map(row => row.value) });
  definition.series.push({ id: 'weighted', aggregate: (sample, values) => values.reduce((sum, value, i) => sum + value * (sample[i].value + 1), 0) / sample.reduce((sum, row) => sum + row.value + 1, 0), data: points.map(row => row.value) });
  const view = analyzeTimeSeries(points, definition, { grain: 'month' });
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].partial, false);
  assert.deepEqual(view.series.map(item => item.data[0]), [465, 1030, 15, 20]);
  assert.equal(analyzeTimeSeries(points.slice(3), spec(points.slice(3)), { grain: 'month' }).rows[0].partial, true);
  assert.equal(points[0].value, 0);
});

test('missing days or null flow inputs never become zero; stocks take only the last available observation', () => {
  const points = rows(14).filter((_, i) => i !== 4);
  const view = analyzeTimeSeries(points, spec(points), { grain: 'week' });
  assert.deepEqual(view.series[0].data, [null, 70]);
  assert.deepEqual(view.series[1].data, [1006, 1013]);
  points.at(-1).balance = null;
  assert.equal(analyzeTimeSeries(points, spec(points), { grain: 'week' }).series[1].data[1], null);
  points[0].value = null;
  assert.equal(analyzeTimeSeries(points, spec(points), { grain: 'month' }).series[0].data[0], null);
});

test('7/30/90 averages use full daily lookback, fresh nulls, independent visibility and W/M closing-day samples', () => {
  const history = rows(), visible = history.slice(-10), definition = spec(visible);
  for (const grain of ['day', 'week', 'month']) {
    const view = analyzeTimeSeries(visible, definition, { grain, hidden: ['flow', 'stock'],
      rolling: ['flow-7d', 'flow-30d', 'flow-90d'], historyRows: history, historySpec: spec(history) });
    assert.deepEqual(view.hiddenAxes, ['stock']);
    assert.ok(view.series[0].data.length === 0);
    assert.deepEqual(view.series.slice(2).map(item => item.data.at(-1)), [96, 84.5, 54.5]);
    assert.deepEqual(view.series.slice(2).map(item => item.lineType), ['solid', 'dashed', 'dotted']);
  }
  const sparse = history.filter((_, i) => i !== 5);
  const average = rollingDailyValues(sparse, sparse.map(row => row.value), 7);
  assert.equal(average.get(history[10].day), null);
  assert.equal(average.get(history[12].day), 9);
  visible.at(-1).value = null;
  const view = analyzeTimeSeries(visible, spec(visible), { rolling: ['flow-7d'], historyRows: history, historySpec: spec(history) });
  assert.equal(view.series.at(-1).data.at(-1), null);
});

test('monthly-only/weekly-only sources cannot be split into fictional daily buckets or rolling means', () => {
  const points = rows(2);
  for (const sourceGrain of ['month', 'week']) {
    const definition = { ...spec(points), sourceGrain };
    const view = analyzeTimeSeries(points, definition, { grain: 'day', rolling: ['flow-7d'] });
    assert.equal(view.grain, sourceGrain);
    assert.equal(view.series.length, 2);
    assert.deepEqual(view.rows, points);
  }
});

test('event calendar uses verified times, observed closing balances, and block-count weighting across days', () => {
  const metrics = [
    { id: 'seconds', label: 'INTERVAL', color: '#00cc66', value: row => row.seconds, weight: row => row.blocks },
    { id: 'bond', label: 'BOND', color: '#5588cc', value: row => row.bond, reduce: 'last', aggregate: 'last' }
  ];
  const days = eventCalendarDays([
    { time: '2024-01-01T01:00:00Z', seconds: 2, blocks: 10, bond: 4 },
    { time: '2024-01-01T02:00:00Z', seconds: 8, blocks: 20, bond: 8 },
    { time: '2024-01-02T03:00:00Z', seconds: 4, blocks: 30, bond: 5 },
    { time: 'not a date', seconds: 100, blocks: 100, bond: 100 }
  ], metrics);
  assert.equal(days[0].seconds, 6);
  assert.equal(days[0].bond, 8);
  assert.ok(days.every(row => row.partial));
  const option = buildEventCalendarOption(days, { metrics, analysis: { grain: 'week' } });
  assert.equal(option.series[0].data[0], 5);
  assert.equal(option.series[1].data[0], 5);
});

test('WASM calendar month aggregation uses variable durations, not 30-day pseudo-months', () => {
  const result = aggregateWasmArbEconomicsBuckets([
    { bucketStart: '2024-02-29T12:00:00Z', bucketSeconds: 3600 },
    { bucketStart: '2024-03-01T00:00:00Z', bucketSeconds: 3600 }
  ], 'month');
  assert.deepEqual(result.map(row => [row.bucketStart, row.bucketSeconds]), [
    ['2024-02-01T00:00:00.000Z', 29 * 86400], ['2024-03-01T00:00:00.000Z', 31 * 86400]
  ]);
  assert.ok(result.every(row => row.partial));
});

test('comparison daily read-model has identical accounting and the same verified cutoff as monthly payload', () => {
  const cache = emptyComparisonCache();
  const raw = { earnings: { liquidityFees: '10000000000', blockRewards: '-1000000', runePriceUSD: '2' },
    wallets: { frontend_near: 1, other_near: 3 }, nearRevenue: 100, nearPrice: 2, nearIssuance: 200,
    chainflipRevenue: 30, flipPrice: .5, flipIssuance: { atomic: '20000000000000000000' } };
  cache.days['2026-09-01'] = raw; cache.days['2026-09-02'] = raw;
  cache.days['2026-09-03'] = { ...raw, flipIssuance: null };
  const payload = buildComparisonPayload(cache, { now: Date.parse('2026-09-04'), startDay: '2026-09-01' });
  assert.equal(payload.throughDay, '2026-09-02');
  assert.equal(payload.daily.length, 2);
  const monthly = buildComparisonTimeSeries(payload.daily, { analysis: { grain: 'month' } });
  for (const series of monthly.series) assert.equal(series.data[0], payload.months[0].protocols[series.id].netUsd);
  assert.deepEqual(buildComparisonPayload(emptyComparisonCache(), { now: Date.parse('2026-09-04'), startDay: '2026-09-01' }).daily, []);
});

test('real ECharts retains date bounds and resolves zoomed weekly categories back to UTC days', async () => {
  const { init, use } = await import('echarts/core');
  const { BarChart, LineChart } = await import('echarts/charts');
  const { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } = await import('echarts/components');
  const { SVGRenderer } = await import('echarts/renderers');
  use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
  const points = rows(100);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 430 });
  let latest;
  const controller = createTimeSeriesController(chart, { points, options: { analysis: { grain: 'week' } } }, { buildOption: builder, width: () => 1000, onZoom: window => latest = window });
  try {
    chart.dispatchAction({ type: 'dataZoom', dataZoomId: 'time-series-window', startValue: 2, endValue: 4 });
    assert.deepEqual(latest, { startDay: '2024-01-15', endDay: '2024-02-04' });
    controller.update({ points, options: { analysis: { grain: 'day', hidden: ['flow'], rolling: ['flow-7d'] } } });
    const option = chart.getOption();
    assert.equal(option.dataZoom[0].startValue, 14);
    assert.equal(option.dataZoom[0].endValue, 34);
    assert.equal(option.series[0].data.length, 0);
    assert.equal(option.series.at(-1).data.at(-1), 96);
    controller.resetZoom(); assert.equal(latest, null);
  } finally { controller.destroy(); }
});
