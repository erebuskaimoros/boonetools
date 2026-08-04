import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBlockProductionChartScale,
  findNearestBlockProductionPointIndex,
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
