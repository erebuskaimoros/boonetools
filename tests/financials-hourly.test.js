import test from 'node:test';
import assert from 'node:assert/strict';
import { financialHourlyPoint, financialHourlyWindow, sliceFinancialHourlyPayload } from '../shared/financials/hourly.js';
import { buildFinancialHourlyOption, buildFinancialChartOption } from '../src/lib/financials/echarts-options.js';
import { financialEChartsWindow } from '../src/lib/financials/echarts-options.js';

const first = Date.parse('2026-10-24T23:00:00Z') / 1000;
const points = Array.from({ length: 3 }, (_, index) => financialHourlyPoint(first + index * 3600,
  { totalVolume: String(index * 1e8), totalVolumeUSD: String(index * 100) },
  { earnings: '100000000', liquidityFees: '100000000', runePriceUSD: '0.5' }, first + index * 3600 + (index === 2 ? 900 : 3600)));

test('hour categories remain distinct across UTC midnight and use execution USD / hourly income pricing', () => {
  const option = buildFinancialHourlyOption(points);
  assert.deepEqual(option.xAxis.data, points.map(point => point.day));
  assert.deepEqual(option.series[0].data, [0, 1, 2]);
  assert.deepEqual(option.series[1].data, [.5, .5, .5]);
  assert.deepEqual(option.yAxis.map(axis => axis.id), ['volume', 'income', 'runePriceUsd']);
  assert.equal(option._spec.sourceGrain, 'hour');
  const rune = buildFinancialHourlyOption(points, { currency: 'rune' });
  assert.deepEqual(rune.series[1].data, [1, 1, 1]);
  assert.deepEqual(rune.series[2].data, [.5, .5, .5]);
  const tooltip = option.tooltip.formatter([{ dataIndex: 2 }]);
  assert.match(tooltip, /Oct 25.*01:00.*IN PROGRESS/);
  assert.match(tooltip, /Through.*01:15/);
  assert.doesNotMatch(tooltip, /BONDING|APR|Invalid Date/);
  const label = option.xAxis.axisLabel.formatter;
  assert.equal(label(points[0].day), 'Oct 24\n23:00');
  assert.equal(label(points[1].day), 'Oct 25\n00:00');
  assert.equal(label(points[2].day), '\n01:00*');
});

test('dates appear on the first visible hourly tick and the first tick after a skipped UTC boundary', () => {
  const start = Date.parse('2026-10-24T17:00:00Z') / 1000;
  const rows = Array.from({ length: 30 }, (_, index) => financialHourlyPoint(start + index * 3600, null, null));
  const option = buildFinancialHourlyOption(rows, { width: 1000 });
  const ticks = rows.filter((row, index) => option.xAxis.axisLabel.interval(index, row.day));
  assert.deepEqual(ticks.slice(0, 3).map(row => row.day.slice(11, 16)), ['17:00', '21:00', '01:00']);
  // Deliberately invoke the formatter out of order, as the renderer can do.
  assert.equal(option.xAxis.axisLabel.formatter(ticks[2].day), 'Oct 25\n01:00');
  assert.equal(option.xAxis.axisLabel.formatter(ticks[1].day), '\n21:00');
  assert.equal(option.xAxis.axisLabel.formatter(ticks[0].day), 'Oct 24\n17:00');
  const zoomed = buildFinancialHourlyOption(rows, { window: { startDay: rows[12].day, endDay: rows[17].day } });
  assert.equal(zoomed.xAxis.axisLabel.formatter(rows[12].day), 'Oct 25\n05:00');
  assert.equal(zoomed.xAxis.axisLabel.formatter(rows[13].day), '\n06:00');
});

test('hourly zoom and hidden series preserve full timestamps and gaps', () => {
  const window = { startDay: points[1].day, endDay: points[2].day };
  assert.deepEqual(financialEChartsWindow(points, { startValue: 1, endValue: 2 }), window);
  const option = buildFinancialHourlyOption(points, { window, hidden: ['income'] });
  assert.equal(option.dataZoom[0].startValue, 1); assert.equal(option.series[1].data.length, 0);
  assert.doesNotMatch(option.tooltip.formatter([{ dataIndex: 1 }]), /SYSTEM INCOME:/);
  const missing = buildFinancialHourlyOption([financialHourlyPoint(first, null, null)]);
  assert.equal(missing.series[0].data[0], null);
});

test('24h window tracks current UTC hour rather than an older selected daily range', () => {
  const now = Date.parse('2026-10-25T01:17:00Z');
  const window = financialHourlyWindow('24h', now);
  assert.equal(window.to - window.from, 86400);
  const payload = sliceFinancialHourlyPayload({ points }, '24h', now);
  assert.equal(payload.points.length, 24);
  assert.equal(payload.points[0].day, '2026-10-24T02:00:00.000Z');
  assert.equal(payload.points.at(-1).day, '2026-10-25T01:00:00.000Z');
});

test('mounted chart switches daily/hourly renderer behavior without retaining daily date formatting', async () => {
  const { createTimeSeriesController } = await import('../src/lib/charts/controller.js');
  let rendered;
  const chart = { setOption: option => { rendered = option; }, getZr: () => null,
    on() {}, off() {}, dispatchAction() {}, dispose() {} };
  const controller = createTimeSeriesController(chart, { points: [], options: { bucket: 'day' }, window: null },
    { buildOption: buildFinancialChartOption, width: () => 1000 });
  try {
    controller.update({ points, options: { bucket: 'hour' }, window: null });
    assert.equal(rendered.xAxis.axisLabel.formatter(points[0].day), 'Oct 24\n23:00');
    assert.doesNotMatch(rendered.xAxis.axisLabel.formatter(points[0].day), /Invalid Date/);
    assert.equal(rendered.series[0].name, 'HOURLY VOLUME');
    assert.equal(rendered.series.length, 3);
    controller.update({ points: [{ day: '2026-10-25', volumeUsd: 1, incomeUsd: 2, runePriceUsd: .5 }],
      options: { bucket: 'day' }, window: null });
    assert.equal(rendered.series[0].name, 'DAILY VOLUME');
    assert.match(rendered.xAxis.axisLabel.formatter('2026-10-25', 0), /Oct 25/);
  } finally { controller.destroy(); }
});
