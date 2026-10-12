import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeSeriesOption } from '../src/lib/charts/time-series.js';

test('bar borders stay enabled by default and allow explicit per-series widths', () => {
  const option = buildTimeSeriesOption([{ day: '2026-10-01' }], {
    axes: [{ id: 'value', color: '#5588cc', format: String }],
    tooltip: () => '',
    series: [undefined, 0, 2].map((barBorderWidth, index) => ({
      id: `bar-${index}`, label: `Bar ${index}`, mark: 'bar', axis: 'value',
      color: '#5588cc', data: [10], barBorderWidth
    }))
  });
  assert.deepEqual(option.series.map(item => item.itemStyle.borderWidth), [1, 0, 2]);
  assert.ok(option.series.every(item => item.itemStyle.borderColor === '#5588cc'));
});
