import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyChartAnalytics } from '../src/lib/charts/legacy-analytics.js';

function fixture() {
  const rows = Array.from({ length: 100 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), amount: i }));
  const visible = new Map();
  const chart = {
    config: { type: 'bar' },
    data: { datasets: [{ label: 'VOLUME', borderColor: '#5588cc', data: rows.map(row => row.amount), yAxisID: 'y' }] },
    options: { plugins: { legend: { display: true }, tooltip: { callbacks: { label: () => 'original details' } } }, scales: { y: {} } },
    setDatasetVisibility: (i, value) => visible.set(i, value),
    isDatasetVisible: i => visible.get(i),
    update: () => {}
  };
  return { rows, chart };
}

test('legacy toolbar preserves raw data/callbacks, independently hides series and removes overlays on refresh', () => {
  const render = createLegacyChartAnalytics(), { rows, chart } = fixture();
  const metrics = [{ id: 'volume', value: row => row.amount }];
  render(chart, rows, rows, metrics, ['volume'], ['volume-7d', 'volume-90d']);
  assert.equal(chart.data.datasets.length, 3);
  assert.equal(chart.isDatasetVisible(0), false);
  assert.equal(chart.isDatasetVisible(1), true);
  assert.equal(chart.data.datasets[2].data.at(-1), 54.5);
  assert.equal(chart.options.scales.y.display, true);
  assert.equal(chart.options.plugins.legend.display, false);
  assert.equal(chart.options.plugins.tooltip.callbacks.label({ dataset: chart.data.datasets[0] }), 'original details');
  render(chart, rows, rows, metrics, ['volume'], []);
  assert.equal(chart.data.datasets.length, 1);
  assert.equal(chart.options.scales.y.display, false);
  render(chart, rows, rows, metrics, [], []);
  assert.equal(chart.isDatasetVisible(0), true);
  assert.deepEqual(chart.data.datasets[0].data, rows.map(row => row.amount));
});

test('partial calendar buckets use the latest actual daily average, not their future closing date', () => {
  const render = createLegacyChartAnalytics(), { rows, chart } = fixture();
  render(chart, [{ day: '2026-04-01', throughDay: '2026-04-30' }], rows, [{ id: 'volume', value: row => row.amount }], [], ['volume-30d']);
  assert.equal(chart.data.datasets[1].data[0], 84.5);
});

test('weighted feature reducers and gaps survive legacy monthly display', () => {
  const render = createLegacyChartAnalytics(), { rows, chart } = fixture();
  const metrics = [{ id: 'volume', value: row => row.amount, rollingReduce: (_sample, values) => values.reduce((sum, value) => sum + value * value, 0) / values.reduce((sum, value) => sum + value, 0) }];
  render(chart, rows, rows, metrics, [], ['volume-7d']);
  assert.equal(chart.data.datasets[1].data.at(-1), 96 + 4 / 96);
  render(chart, rows, rows.filter((_, i) => i !== 95), metrics, [], ['volume-7d']);
  assert.equal(chart.data.datasets[1].data.at(-1), null);
});

test('rolling tooltip values retain feature currency, bps, and percent denominations', () => {
  for (const [format, expected] of [
    [value => `$${value.toFixed(2)}`, '$96.00'],
    [value => `${value.toFixed(2)} RUNE`, '96.00 RUNE'],
    [value => `${value.toFixed(2)} bps`, '96.00 bps'],
    [value => `${value.toFixed(2)}%`, '96.00%']
  ]) {
    const render = createLegacyChartAnalytics(), { rows, chart } = fixture();
    render(chart, rows, rows, [{ id: 'volume', value: row => row.amount, format }], [], ['volume-7d']);
    const dataset = chart.data.datasets[1];
    const label = chart.options.plugins.tooltip.callbacks.label({
      dataset, dataIndex: 99, parsed: { y: dataset.data[99] }, formattedValue: '96'
    });
    assert.equal(label, `7D AVG · VOLUME: ${expected} · daily mean`);
    assert.equal(chart.options.plugins.tooltip.callbacks.label({ dataset: chart.data.datasets[0] }), 'original details');
  }
});

test('rolling tooltip formatting is refreshed and missing windows are never formatted as zero', () => {
  const render = createLegacyChartAnalytics(), { rows, chart } = fixture();
  const metrics = [{ id: 'volume', value: row => row.amount, format: value => `$${value}` }];
  render(chart, rows, rows, metrics, [], ['volume-7d']);
  metrics[0].format = value => `${value} RUNE`;
  render(chart, rows, rows, metrics, [], ['volume-7d']);
  const label = chart.options.plugins.tooltip.callbacks.label;
  const dataset = chart.data.datasets[1];
  assert.equal(label({ dataset, dataIndex: 99, parsed: { y: 96 }, formattedValue: '96' }), '7D AVG · VOLUME: 96 RUNE · daily mean');
  assert.equal(label({ dataset, dataIndex: 0, parsed: { y: null }, formattedValue: '0' }), '7D AVG · VOLUME: unavailable · daily mean');
});
