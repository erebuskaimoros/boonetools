import test from 'node:test';
import assert from 'node:assert/strict';
import { appLayerChartRange } from '../src/lib/app-layer/chart-range.js';

const daily = Array.from({ length: 90 }, (_, index) => ({
  bucket_start: new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10),
  cumulative_usd: 1000 + index
}));

test('App Layer charts default to the latest 30 daily buckets without rebasing cumulative values', () => {
  assert.deepEqual(appLayerChartRange(daily), { min: 60, max: 89 });
  assert.equal(daily[60].cumulative_usd, 1060);
  assert.equal(daily.length, 90);
});

test('App Layer chart ranges use calendar days and include overlapping weekly buckets', () => {
  const weekly = daily.filter((_, index) => index % 7 === 0);
  assert.deepEqual(appLayerChartRange(weekly, 30, 'weekly'), { min: 8, max: 12 });
  assert.deepEqual(appLayerChartRange([daily[0], daily[85], daily[89]]), { min: 1, max: 2 });
});

test('all-time, short and empty chart histories remain available', () => {
  assert.deepEqual(appLayerChartRange(daily, null), {});
  assert.deepEqual(appLayerChartRange(daily.slice(0, 5)), { min: 0, max: 4 });
  assert.deepEqual(appLayerChartRange([]), {});
});
