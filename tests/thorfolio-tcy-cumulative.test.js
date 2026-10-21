import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPayoutChartSeries, mergePayoutSeries, rowsFor } from '../src/lib/position-tracker/model.js';

const DAY = 86400;
const rows = [
  { address: 'a', payouts: [{ date: DAY + 1, rune: 2, usdAtPayout: 4 }, { date: DAY * 3, rune: 3, usdAtPayout: 3 }] },
  { address: 'b', payouts: [{ date: DAY + 2, rune: 1, usdAtPayout: 2 }, { date: DAY * 2, rune: 4, usdAtPayout: 12 }] }
];

test('cumulative payouts sum combined daily rewards and historical payout values separately', () => {
  const daily = mergePayoutSeries(rows);
  const snapshot = structuredClone(daily);
  const chart = buildPayoutChartSeries(daily);
  assert.deepEqual(chart.map((day) => day.rune), [3, 4, 3]);
  assert.deepEqual(chart.map((day) => day.cumulativeRune), [3, 7, 10]);
  assert.deepEqual(chart.map((day) => day.cumulativeUsdAtPayout), [6, 18, 21]);
  assert.deepEqual(daily, snapshot, 'chart calculations do not mutate daily payout data');
});

test('changing date range preserves total payouts to date, including payouts before the range', () => {
  const daily = mergePayoutSeries(rows);
  const chart = buildPayoutChartSeries(daily, DAY * 2);
  assert.deepEqual(chart.map((day) => day.date), [DAY * 2, DAY * 3]);
  assert.deepEqual(chart.map((day) => day.rune), [4, 3]);
  assert.deepEqual(chart.map((day) => day.cumulativeRune), [7, 10]);
  assert.deepEqual(chart.map((day) => day.cumulativeUsdAtPayout), [18, 21]);
  assert.equal(chart.at(-1).cumulativeRune, buildPayoutChartSeries(daily).at(-1).cumulativeRune);
  assert.equal(buildPayoutChartSeries(daily).at(-1).cumulativeRune, 10);
  assert.deepEqual(buildPayoutChartSeries(daily, DAY * 4), []);
});

test('address filtering keeps lifetime totals scoped to that address regardless of range and input order', () => {
  const daily = mergePayoutSeries(rowsFor(rows, 'a')).reverse();
  const chart = buildPayoutChartSeries(daily);
  assert.deepEqual(chart.map((day) => day.cumulativeRune), [2, 5]);
  assert.deepEqual(chart.map((day) => day.cumulativeUsdAtPayout), [4, 7]);
  assert.deepEqual(daily.map((day) => day.date), [DAY * 3, DAY]);
  assert.equal(buildPayoutChartSeries(daily, DAY * 3)[0].cumulativeRune, 5);
  assert.equal(buildPayoutChartSeries(daily, DAY * 3)[0].cumulativeUsdAtPayout, 7);
  assert.deepEqual(buildPayoutChartSeries(), []);
});
