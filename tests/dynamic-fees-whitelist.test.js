import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWhitelistHistory, positionWhitelistMarkers, createWhitelistMarkerPlugin
} from '../src/lib/dynamic-fees/whitelist.js';

const event = (state, day, height, extra = {}) => ({
  effective_value: String(state), block_time: `2026-09-${day}T12:00:00Z`, height,
  tx_id: 'A'.repeat(64), ...extra
});
const payload = rows => ({ mimir_key: 'DYNAMICFEE-WHITELIST-SS', effective_history: rows });
const seconds = value => Date.parse(value) / 1000;
const point = (start, end) => ({ startTime: seconds(start), endTime: seconds(end) });

test('whitelist history uses effective changes, not individual votes or current state', () => {
  const input = { ...payload([event(1, '01', 10), event(0, '03', 30), event(1, '05', 50)]),
    events: [event(1, '02', 20)], current_value: 1 };
  const before = structuredClone(input);
  const rows = normalizeWhitelistHistory(input, 'sS');
  assert.deepEqual(rows.map(row => row.kind), ['active', 'removed', 'active']);
  assert.deepEqual(rows.map(row => row.label), ['Whitelisted', 'Removed from whitelist', 'Whitelisted']);
  assert.ok(rows.every(row => row.estimated));
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeWhitelistHistory(input, 'ej'), []);
  assert.deepEqual(normalizeWhitelistHistory({ ...payload([]), current_value: 1 }, 'ss'), []);
});

test('protocol evidence wins over adjacent same-state reconstructed consensus without losing removals', () => {
  const rows = normalizeWhitelistHistory(payload([
    event(1, '25', 60, { change_source: 'validator_consensus' }),
    event(1, '25', 59), event(0, '22', 40), event(0, '21', 30), event(1, '01', 10)
  ]), 'ss');
  assert.deepEqual(rows.map(row => row.height), [10, 30, 60]);
  assert.deepEqual(rows.map(row => row.estimated), [true, true, false]);
});

test('monitor mode stays distinct; deletion/off duplicates and invalid values are excluded', () => {
  const rows = normalizeWhitelistHistory(payload([
    event(1, '01', 10), event(2, '02', 20), event(-1, '03', 30), event(0, '04', 40),
    event('', '05', 50), event(null, '06', 60), event(3, '07', 70),
    { ...event(1, '08', 80), block_time: 'invalid' }, event(1, '09', 0)
  ]), 'ss');
  assert.deepEqual(rows.map(row => row.kind), ['active', 'monitor', 'removed']);
});

test('D/W/M positions use exact UTC time within each displayed bucket and omit outside events', () => {
  const rows = normalizeWhitelistHistory(payload([event(1, '02', 20)]), 'ss');
  for (const points of [
    [point('2026-09-01', '2026-09-02'), point('2026-09-02', '2026-09-03')],
    [point('2026-09-01', '2026-09-08')],
    [point('2026-09-01', '2026-10-01')]
  ]) {
    const markers = positionWhitelistMarkers(rows, points);
    assert.equal(markers.length, 1);
    const p = points[markers[0].bucketIndex];
    assert.equal(markers[0].xValue, markers[0].bucketIndex - 0.5 + (rows[0].timestamp - p.startTime) / (p.endTime - p.startTime));
  }
  assert.deepEqual(positionWhitelistMarkers(rows, [point('2026-09-03', '2026-09-04')]), []);
  assert.deepEqual(positionWhitelistMarkers(rows, []), []);
  const atEnd = normalizeWhitelistHistory(payload([{ ...event(1, '02', 20), block_time: '2026-09-03T00:00:00Z' }]), 'ss');
  assert.deepEqual(positionWhitelistMarkers(atEnd, [point('2026-09-02', '2026-09-03')]), []);
});

test('events in missing-day gaps sit between buckets without inventing a metric observation', () => {
  const rows = normalizeWhitelistHistory(payload([event(1, '02', 20)]), 'ss');
  const [marker] = positionWhitelistMarkers(rows, [point('2026-09-01', '2026-09-02'), point('2026-09-03', '2026-09-04')]);
  assert.equal(marker.xValue, 0.5);
  assert.equal(marker.bucketIndex, null);
});

test('canvas markers use the current zoom scale, clip outside zoom and do not modify data', () => {
  const strokes = [], labels = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setLineDash() {},
    moveTo(x, y) { strokes.push([x, y]); }, lineTo() {}, stroke() {}, fillRect() {},
    measureText(text) { return { width: text.length * 6 }; }, fillText(text) { labels.push(text); } };
  const markers = [{ xValue: 1, label: 'Whitelisted', date: '2026-09-02', color: '#00cc66' },
    { xValue: 8, label: 'Removed from whitelist', date: '2026-09-03', color: '#d4a017' }];
  const chart = { ctx, chartArea: { left: 10, right: 400, top: 20, bottom: 200 },
    scales: { x: { getPixelForValue: value => 10 + value * 100 } }, data: { datasets: [{ data: [1, 2] }] } };
  const before = structuredClone(chart.data);
  const plugin = createWhitelistMarkerPlugin(() => markers);
  plugin.afterDatasetsDraw(chart);
  assert.deepEqual(strokes, [[110, 20]]);
  assert.equal(labels.length, 1);
  assert.deepEqual(chart.data, before);
  chart.scales.x.getPixelForValue = value => 10 + value * 25;
  strokes.length = 0;
  plugin.afterDatasetsDraw(chart);
  assert.deepEqual(strokes, [[35, 20], [210, 20]]);
});
