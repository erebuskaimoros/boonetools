import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildBlockProductionChartScale,
  chainHeadToBlockIntervalPoint,
  decodeBlockIntervalPayload,
  findNearestBlockProductionPointIndex,
  mergeBlockIntervalPoints,
  projectBlockProductionChartY
} from '../src/lib/status/block-production-chart.js';

test('block production scale follows the visible data instead of forcing a zero baseline', () => {
  const scale = buildBlockProductionChartScale([
    { seconds: 5.82 },
    { seconds: 6.06 },
    { seconds: 6.21 }
  ]);

  assert.ok(scale.min > 5.5);
  assert.ok(scale.min < 5.82);
  assert.ok(scale.max > 6.21);
  assert.ok(scale.max < 6.5);
  assert.equal(scale.ticks.length, 5);
});

test('block production scale includes the six-second target and recalculates for a zoomed window', () => {
  const fullWindow = buildBlockProductionChartScale([
    { seconds: 5.8 },
    { seconds: 11.4 }
  ]);
  const zoomedWindow = buildBlockProductionChartScale([
    { seconds: 6.1 },
    { seconds: 6.3 }
  ]);

  assert.ok(fullWindow.min < 5.8 && fullWindow.max > 11.4);
  assert.ok(zoomedWindow.min < 6 && zoomedWindow.max > 6.3);
  assert.ok(zoomedWindow.max - zoomedWindow.min < fullWindow.max - fullWindow.min);
});

test('block production projection keeps equal seconds-per-pixel without centering the target', () => {
  const chart = { top: 16, bottom: 184, min: 5.5, max: 8.5 };
  const sixSeconds = projectBlockProductionChartY(6, chart);
  const sevenSeconds = projectBlockProductionChartY(7, chart);
  const eightSeconds = projectBlockProductionChartY(8, chart);

  assert.ok(sixSeconds > (chart.top + chart.bottom) / 2);
  assert.ok(Math.abs((sixSeconds - sevenSeconds) - (sevenSeconds - eightSeconds)) < 1e-9);
  assert.equal(projectBlockProductionChartY(chart.max, chart), chart.top);
  assert.equal(projectBlockProductionChartY(chart.min, chart), chart.bottom);
});

test('block production chart-wide hover selects the sample nearest the pointer time', () => {
  const points = [
    { timestamp: 1_000 },
    { timestamp: 2_000 },
    { timestamp: 5_000 }
  ];

  assert.equal(findNearestBlockProductionPointIndex(points, 1_100), 0);
  assert.equal(findNearestBlockProductionPointIndex(points, 3_600), 2);
  assert.equal(findNearestBlockProductionPointIndex(points, 5_000), 2);
  assert.equal(findNearestBlockProductionPointIndex([], 3_600), null);
});

test('compact per-block tuples decode and merge by height for replay plus live updates', () => {
  const decoded = decodeBlockIntervalPayload({
    columns: ['height', 'time_ms', 'interval_ms', 'has_swap_events'],
    points: [
      [100, Date.parse('2026-08-05T12:00:00Z'), 6000, 0],
      [101, Date.parse('2026-08-05T12:00:06.125Z'), 6125, 1]
    ]
  });
  assert.equal(decoded.length, 2);
  assert.equal(decoded[1].seconds_per_block, 6.125);
  assert.equal(decoded[1].block_count, 1);
  assert.equal(decoded[1].has_swap_events, true);

  const live = chainHeadToBlockIntervalPoint({
    height: 102,
    time: '2026-08-05T12:00:12Z',
    interval_ms: 5875
  });
  const merged = mergeBlockIntervalPoints(decoded, [
    { ...decoded[1], seconds_per_block: 6.2 },
    live
  ], {
    nowMs: Date.parse('2026-08-05T12:01:00Z')
  });
  assert.deepEqual(merged.map((point) => point.height), [100, 101, 102]);
  assert.equal(merged[1].seconds_per_block, 6.2);
});

test('nearest-point lookup remains logarithmic-friendly for a full day of blocks', () => {
  const points = Array.from({ length: 14_400 }, (_, index) => ({
    timestamp: index * 6_000
  }));
  assert.equal(findNearestBlockProductionPointIndex(points, 43_201_000), 7200);
  assert.equal(findNearestBlockProductionPointIndex(points, -1), 0);
  assert.equal(findNearestBlockProductionPointIndex(points, Number.MAX_SAFE_INTEGER), 14_399);
});

test('block production drag surface stays above the series without per-block DOM targets or a zoom-in cursor', () => {
  const component = readFileSync(
    new URL('../src/lib/status/BlockProductionChart.svelte', import.meta.url),
    'utf8'
  );
  const seriesLine = component.indexOf('class="series-line"');
  const dragSurface = component.indexOf('class="zoom-capture"');

  assert.ok(seriesLine >= 0);
  assert.ok(
    dragSurface > seriesLine,
    'the drag surface must remain above the rendered series so selection follows the pointer'
  );
  assert.doesNotMatch(component, /\{#each points as point, index\}/);
  assert.doesNotMatch(component, /class="point-target"/);
  assert.doesNotMatch(component, /cursor:\s*zoom-in/);
});
