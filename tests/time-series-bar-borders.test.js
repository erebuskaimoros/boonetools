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

test('zero-value bars draw no border, so an empty day shows nothing', () => {
  const option = buildTimeSeriesOption([{ day: '2026-10-01' }, { day: '2026-10-02' }, { day: '2026-10-03' }, { day: '2026-10-04' }], {
    axes: [{ id: 'value', color: '#5588cc', format: String }],
    tooltip: () => '',
    series: [
      { id: 'bar', label: 'Bar', mark: 'bar', axis: 'value', color: '#5588cc', data: [0, 10, null, -0] },
      { id: 'line', label: 'Line', mark: 'line', axis: 'value', color: '#5588cc', data: [0, 10, null, 0] }
    ]
  });
  const [bar, line] = option.series;
  const borderWidth = (entry) => entry?.itemStyle?.borderWidth ?? bar.itemStyle.borderWidth;
  const value = (entry) => (entry !== null && typeof entry === 'object' ? entry.value : entry);
  assert.deepEqual(bar.data.map(borderWidth), [0, 1, 1, 0]);
  assert.deepEqual(bar.data.map(value), [0, 10, null, 0]);
  assert.deepEqual(line.data, [0, 10, null, 0]);
});
