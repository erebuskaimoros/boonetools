import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTERACTIVE_CHART_LEGEND,
  isChartTrendVisible,
  toggleHiddenChartTrend
} from '../src/lib/charts/terminal.js';

test('interactive chart legends hide and restore dataset trends', () => {
  const calls = [];
  const chart = {
    isDatasetVisible: (datasetIndex) => datasetIndex !== 2,
    hide: (datasetIndex) => calls.push(['hide', datasetIndex]),
    show: (datasetIndex) => calls.push(['show', datasetIndex])
  };

  INTERACTIVE_CHART_LEGEND.onClick({}, { datasetIndex: 1 }, { chart });
  INTERACTIVE_CHART_LEGEND.onClick({}, { datasetIndex: 2 }, { chart });

  assert.deepEqual(calls, [
    ['hide', 1],
    ['show', 2]
  ]);
});

test('interactive chart legends toggle indexed chart segments', () => {
  const calls = [];
  const chart = {
    toggleDataVisibility: (dataIndex) => calls.push(['toggle', dataIndex]),
    update: () => calls.push(['update'])
  };

  INTERACTIVE_CHART_LEGEND.onClick({}, { index: 3 }, { chart });

  assert.deepEqual(calls, [
    ['toggle', 3],
    ['update']
  ]);
});

test('interactive chart legends expose pointer affordance', () => {
  const target = { style: { cursor: 'default' } };
  const event = { native: { target } };

  INTERACTIVE_CHART_LEGEND.onHover(event);
  assert.equal(target.style.cursor, 'pointer');

  INTERACTIVE_CHART_LEGEND.onLeave(event);
  assert.equal(target.style.cursor, 'default');
});

test('custom chart trend visibility toggles without mutating prior state', () => {
  const initial = ['oracle'];
  const restored = toggleHiddenChartTrend(initial, 'oracle');
  const hiddenAverage = toggleHiddenChartTrend(restored, 'average:6h');

  assert.deepEqual(initial, ['oracle']);
  assert.deepEqual(restored, []);
  assert.deepEqual(hiddenAverage, ['average:6h']);
  assert.equal(isChartTrendVisible(hiddenAverage, 'oracle'), true);
  assert.equal(isChartTrendVisible(hiddenAverage, 'average:6h'), false);
});
