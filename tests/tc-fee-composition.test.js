import test from 'node:test';
import assert from 'node:assert/strict';
import { init, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { buildFeeShareOption, feeShare, feeShareSummary, normalizeFeeComposition, selectFeeCompositionRange } from '../src/lib/tc-fee-dash/composition.js';

use([LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
const row = (day, btc = 40, eth = 20, stablecoins = 30, other = 10) => ({
  day, complete: true, totalFeesUsd: btc + eth + stablecoins + other,
  fees: { btc, eth, stablecoins, other }, source: 'cached-pool-history'
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('four shares total 100%, retain genuine zeros, and have no percentage on zero-fee days', () => {
  const points = normalizeFeeComposition([row('2026-10-01'), row('2026-10-02', 0, 0, 100, 0), row('2026-10-03', 0, 0, 0, 0)]);
  const option = buildFeeShareOption(points);
  assert.deepEqual(option.series.map(item => item.data), [[40, 0, null], [20, 0, null], [30, 100, null], [10, 0, null]]);
  assert.deepEqual(option.series.map(item => item.stack), Array(4).fill('fee-share'));
  assert.match(option.tooltip.formatter([{ dataIndex: 2 }]), /percentage shares are undefined/);
  assert.equal(feeShare([], 'btc'), null);
});

test('weekly/monthly percentages are ratios of summed fees, never mean daily percentages', () => {
  const points = normalizeFeeComposition([row('2026-10-01', 100, 0, 0, 0), row('2026-10-02', 0, 100, 100, 700), row('2026-10-03', 0, 0, 0, 0)]);
  for (const grain of ['week', 'month']) {
    const option = buildFeeShareOption(points, { analysis: { grain } });
    assert.deepEqual(option.series.map(item => item.data), [[10], [10], [10], [70]]);
    assert.equal(option.yAxis[0].min, 0);
    assert.equal(option.yAxis[0].max, 100);
    assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /BTC: 10.0% · \$100.00/);
    assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /TC LIQUIDITY FEES: \$1,000.00/);
  }
});

test('interior missing or unreconciled days remain gaps and invalidate grouped attribution', () => {
  const points = normalizeFeeComposition([
    row('2026-10-01'), row('2026-10-03'),
    { ...row('2026-10-04'), totalFeesUsd: 101 },
    { ...row('2026-10-05'), fees: { btc: 100 } }
  ]);
  assert.equal(points.length, 5);
  assert.deepEqual(points.map(point => point.complete), [true, false, true, false, false]);
  assert.deepEqual(buildFeeShareOption(points).series[0].data, [40, null, 40, null, null]);
  const option = buildFeeShareOption(points, { analysis: { grain: 'month' } });
  assert.ok(option.series.every(item => item.data[0] === null));
  assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /ATTRIBUTION INCOMPLETE/);
  assert.doesNotMatch(option.tooltip.formatter([{ dataIndex: 0 }]), /BTC: 40/);
});

test('range summary counts verified days and weights only their fees; presets use UTC calendar days', () => {
  const points = normalizeFeeComposition([row('2026-10-01', 100, 0, 0, 0), row('2026-10-03', 0, 100, 100, 700)]);
  const summary = feeShareSummary(points);
  assert.equal(summary.verifiedDays, 2);
  assert.equal(summary.missingDays, 1);
  assert.deepEqual(summary.cards.map(card => card.value), [10, 10, 10, 70]);
  assert.match(summary.cards[0].detail, /\$100.00 verified fees/);
  assert.deepEqual(selectFeeCompositionRange(points, 2).map(point => point.day), ['2026-10-02', '2026-10-03']);
  assert.equal(selectFeeCompositionRange(points, 'all'), points);
  assert.ok(feeShareSummary([]).cards.every(card => card.value === null));
});

test('invalid calendar dates are rejected and current-day attribution is labeled partial', () => {
  assert.deepEqual(normalizeFeeComposition([null, row('2026-02-30'), row('0001-01-01'), row('invalid')]), []);
  const option = buildFeeShareOption(normalizeFeeComposition([{ ...row('2026-10-22'), partial: true }]));
  assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /PARTIAL DAY/);
});

test('composition always retains all four shaded categories, even with legacy hidden/overlay options', () => {
  const points = normalizeFeeComposition([row('2026-10-01'), row('2026-10-02')]);
  for (const grain of ['day', 'week', 'month']) {
    const option = buildFeeShareOption(points, { analysis: { grain, hidden: ['btc'] } });
    assert.equal(option.series.length, 4);
    assert.equal(option.series[0].data[0], 40);
    assert.equal(option.series[1].data[0], 20);
    assert.equal(option.yAxis[0].max, 100);
    assert.ok(option.series.every(item => item.areaStyle && item.stack === 'fee-share'));
    const html = option.tooltip.formatter([{ dataIndex: 0 }]);
    assert.match(html, /data-series="btc"/);
    assert.match(html, /TC LIQUIDITY FEES: \$[12]00.00/);
    assert.match(html, /all four/);
  }
});

test('7D replaces raw values with four fee-weighted areas, retains zeros and requires complete windows', () => {
  const points = normalizeFeeComposition(Array.from({ length: 8 }, (_, index) =>
    row(`2026-10-0${index + 1}`, index === 0 ? 100 : 0, index === 1 ? 900 : 0, 0, 0)));
  const option = buildFeeShareOption(points, { smoothingDays: 7, analysis: { grain: 'day', rolling: ['btc-7d'] } });
  assert.equal(option.series.length, 4);
  assert.deepEqual(option.series[0].data, [null, null, null, null, null, null, 10, 0]);
  assert.deepEqual(option.series[1].data, [null, null, null, null, null, null, 90, 100]);
  assert.ok(option.series.every(item => item.stack === 'fee-share' && item.areaStyle));
  assert.match(option.tooltip.formatter([{ dataIndex: 6 }]), /7D TRAILING/);
  assert.match(option.tooltip.formatter([{ dataIndex: 6 }]), /2026-10-01 → 2026-10-07/);
  assert.match(option.tooltip.formatter([{ dataIndex: 6 }]), /BTC: 10.0%/);
  points[2].complete = false;
  assert.ok(buildFeeShareOption(points, { smoothingDays: 7 }).series.every(item => item.data.every(value => value === null)));
});

const longHistory = () => normalizeFeeComposition(Array.from({ length: 70 }, (_, index) =>
  row(new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10), index + 1, 5, 8, 10)));

test('30D uses cached lookback before the visible range without summing overlapping windows on W/M', () => {
  const history = longHistory(), points = history.slice(50);
  for (const days of [7, 30]) {
    for (const grain of ['day', 'week', 'month']) {
      const option = buildFeeShareOption(points, { smoothingDays: days, feeHistory: history, analysis: { grain } });
      assert.equal(option.series.length, 4);
      for (let index = 0; index < option._rows.length; index++) {
        const day = option._rows[index].throughDay || option._rows[index].day;
        const end = history.findIndex(row => row.day === day);
        const sample = history.slice(end - days + 1, end + 1);
        near(option.series[0].data[index], feeShare(sample, 'btc'));
        near(option.series.reduce((sum, series) => sum + series.data[index], 0), 100);
      }
      const last = option._rows.length - 1;
      assert.match(option.tooltip.formatter([{ dataIndex: last }]), new RegExp(`${days}D TRAILING`));
      assert.equal(option.yAxis[0].max, 100);
    }
  }
});

test('rolling rejects short/gapped/zero-only windows and unsupported 90D falls back to raw', () => {
  const history = longHistory();
  const sparse = history.filter((_, index) => index !== 65);
  const gapOption = buildFeeShareOption(sparse.slice(-3), { feeHistory: sparse, smoothingDays: 7 });
  assert.ok(gapOption.series.every(item => item.data.every(value => value === null)));
  const zero = history.map(point => row(point.day, 0, 0, 0, 0));
  assert.ok(buildFeeShareOption(zero, { smoothingDays: 30 }).series.every(item => item.data.every(value => value === null)));
  const unsupported = buildFeeShareOption(history, { smoothingDays: 90 });
  near(unsupported.series[0].data.at(-1), feeShare([history.at(-1)], 'btc'));
});

test('real renderer switches raw → 7D → 30D → raw with exactly four 100% area series', () => {
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 430 });
  const history = longHistory(), points = history.slice(40);
  try {
    for (const smoothingDays of [0, 7, 30, 0]) {
      chart.setOption(buildFeeShareOption(points, { feeHistory: history, smoothingDays }), { notMerge: true });
      assert.equal(chart.getOption().series.length, 4);
      assert.ok(chart.getOption().series.every(item => item.areaStyle && item.stack === 'fee-share'));
      const data = chart.getModel().getSeriesByIndex(3).getData();
      const dimension = data.getCalculationInfo('stackResultDimension');
      for (let index = 0; index < points.length; index++) near(data.get(dimension, index), 100);
    }
  } finally { chart.dispose(); }
});

test('real ECharts stacks to 100%, breaks areas at unavailable days, and renders all four categories', () => {
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 430 });
  const points = normalizeFeeComposition([row('2026-10-01'), row('2026-10-02'), row('2026-10-04'), row('2026-10-05')]);
  try {
    chart.setOption(buildFeeShareOption(points));
    const data = chart.getModel().getSeriesByIndex(3).getData();
    const dimension = data.getCalculationInfo('stackResultDimension');
    for (const index of [0, 1, 3, 4]) near(data.get(dimension, index), 100);
    assert.ok(Number.isNaN(data.get(dimension, 2)));
    assert.equal(chart.getOption().series.length, 4);
    assert.ok(chart.getOption().series.every(item => item.connectNulls === false));
    const svg = chart.renderToSVGString();
    assert.match(svg, /100%/);
    const paths = [...svg.matchAll(/<path d="([^"]*)"[^>]*stroke="#b2b2b2"/g)].map(match => match[1]);
    assert.ok(paths.some(d => (d.match(/M/g) || []).length === 2), 'top outline has two separate segments');
  } finally { chart.dispose(); }
});
