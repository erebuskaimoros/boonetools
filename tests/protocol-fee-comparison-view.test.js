import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, contribution, monthlyComparison, PROTOCOLS } from '../shared/protocol-fee-comparison/model.js';
import { buildComparisonTimeSeries, selectComparisonView } from '../src/lib/protocol-fee-comparison/time-series.js';

const now = Date.parse('2026-10-14T11:00:00Z');
const daily = calendarDays('2026-09-01', '2026-10-14').map(day => ({ day,
  thorchain: { ...contribution(100, day >= '2026-10-07' ? 1 : null), grossIncomeUsd: 105, revshareUsd: 5 },
  near: contribution(20, 200), chainflip: contribution(15, 10)
}));
const months = monthlyComparison(daily, { now, startDay: '2026-09-01' });

test('the explicit verified scope exposes available THORChain days without inventing monthly totals', () => {
  const oldChart = buildComparisonTimeSeries(daily, { analysis: { grain: 'month' } });
  assert.ok(oldChart.series.find(series => series.id === 'thorchain').data.every(value => value === null));
  const view = selectComparisonView(daily, months, { mode: 'verified' });
  assert.equal(view.mode, 'verified');
  assert.equal(view.grain, 'day');
  assert.deepEqual(view.rows.map(row => row.day), calendarDays('2026-10-07', '2026-10-14'));
  const chart = buildComparisonTimeSeries(view.rows, { analysis: { grain: view.grain } });
  for (const { id } of PROTOCOLS) assert.equal(chart.series.find(series => series.id === id).data.filter(value => value !== null).length, 7);
  assert.equal(months.at(-1).protocols.thorchain.netUsd, null, 'a partial observed subtotal must not become a full month');
});

test('full history is the default without replacing missing historical THORChain emissions with zero', () => {
  const view = selectComparisonView(daily, months);
  assert.equal(view.mode, 'full');
  assert.equal(view.grain, 'month');
  assert.deepEqual(view.rows, daily);
  assert.equal(view.rows[0].thorchain.netUsd, null);
});

test('verified comparisons use the latest contiguous common run, keeping observed zero', () => {
  const rows = structuredClone(daily);
  rows.find(row => row.day === '2026-10-10').near = contribution(null, 200);
  rows.at(-1).thorchain = { ...contribution(0, 0), grossIncomeUsd: 0, revshareUsd: 0 };
  const view = selectComparisonView(rows, months, { mode: 'verified' });
  assert.deepEqual(view.rows.map(row => row.day), ['2026-10-11', '2026-10-12', '2026-10-13']);
  assert.equal(view.rows.at(-1).thorchain.netUsd, 0);
  assert.equal(rows.length, daily.length);
});

test('complete historical comparisons keep their monthly default', () => {
  const rows = daily.map(row => ({ ...row, thorchain: contribution(100, 1) }));
  const monthly = monthlyComparison(rows, { now, startDay: '2026-09-01' });
  const view = selectComparisonView(rows, monthly);
  assert.equal(view.mode, 'full');
  assert.equal(view.grain, 'month');
  assert.deepEqual(view.rows, rows);
});

test('verified scope sorts without mutation, stops at calendar holes and ends on the latest observed day', () => {
  const rows = daily.filter(row => row.day !== '2026-10-10').map(row => structuredClone(row)).reverse();
  rows[0].chainflip = contribution(15, null);
  const before = structuredClone(rows);
  const view = selectComparisonView(rows, months, { mode: 'verified' });
  assert.deepEqual(view.rows.map(row => row.day), ['2026-10-11', '2026-10-12']);
  assert.equal(view.fromDay, '2026-10-11');
  assert.equal(view.throughDay, '2026-10-12');
  const full = selectComparisonView(rows, months, { mode: 'full' });
  assert.equal(full.fromDay, '2026-09-01');
  assert.equal(full.throughDay, '2026-10-13');
  assert.deepEqual(full.rows.map(row => row.day), rows.map(row => row.day).reverse());
  assert.deepEqual(rows, before);
});

test('empty or non-overlapping histories remain honest and full history stays accessible', () => {
  const empty = selectComparisonView([], []);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.fromDay, null);
  assert.equal(empty.throughDay, null);
  const rows = daily.map(row => ({ ...row, thorchain: contribution(100, null) }));
  assert.deepEqual(selectComparisonView(rows, months).rows, rows);
  const verified = selectComparisonView(rows, months, { mode: 'verified' });
  assert.equal(verified.mode, 'verified');
  assert.deepEqual(verified.rows, []);
  assert.equal(verified.fromDay, null);
  assert.equal(verified.throughDay, null);
  assert.deepEqual(selectComparisonView(rows, months, { mode: 'full' }).rows, rows);
});

test('monthly-only snapshots keep their native grain and truthful calendar coverage', () => {
  const rows = daily.map(row => ({ ...row, thorchain: contribution(100, 1) }));
  const monthly = monthlyComparison(rows, { now, startDay: '2026-09-01' });
  const before = structuredClone(monthly);
  const full = selectComparisonView([], monthly);
  assert.equal(full.mode, 'full');
  assert.equal(full.sourceGrain, 'month');
  assert.equal(full.grain, 'month');
  assert.equal(full.fromDay, '2026-09-01');
  assert.equal(full.throughDay, '2026-10-13');
  assert.deepEqual(full.rows.map(row => row.day), ['2026-09-01', '2026-10-01']);
  const verified = selectComparisonView([], monthly, { mode: 'verified' });
  assert.equal(verified.grain, 'month');
  assert.equal(verified.rows.length, 2);
  assert.equal(verified.rows.at(-1).partial, true);
  assert.deepEqual(monthly, before);
  assert.deepEqual(selectComparisonView([], months, { mode: 'verified' }).rows, []);
});

test('a covered partial current month retains the full-history monthly default', () => {
  const rows = daily.filter(row => row.day >= '2026-10-01').map(row => ({ ...row, thorchain: contribution(100, 1) }));
  const monthly = monthlyComparison(rows, { now, startDay: '2026-10-01' });
  assert.equal(monthly[0].partial, true);
  assert.equal(monthly[0].protocols.thorchain.complete, true);
  const view = selectComparisonView(rows, monthly);
  assert.equal(view.mode, 'full');
  assert.equal(view.grain, 'month');
  assert.deepEqual(view.rows, rows);
});

test('explicit scopes survive refreshed data as historical coverage improves', () => {
  const complete = daily.map(row => ({ ...row, thorchain: contribution(100, 1) }));
  const monthly = monthlyComparison(complete, { now, startDay: '2026-09-01' });
  assert.equal(selectComparisonView(daily, months).mode, 'full');
  const original = selectComparisonView(daily, months, { mode: 'verified' });
  assert.equal(selectComparisonView(complete, monthly).mode, 'full');
  assert.equal(selectComparisonView(complete, monthly, { mode: original.mode }).mode, 'verified');
  assert.equal(selectComparisonView(complete, monthly, { mode: 'full' }).mode, 'full');
  assert.equal(selectComparisonView(daily, months, { mode: 'full' }).mode, 'full');
});
