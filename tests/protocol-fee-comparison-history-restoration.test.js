import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, contribution, monthlyComparison } from '../shared/protocol-fee-comparison/model.js';
import { selectComparisonView } from '../src/lib/protocol-fee-comparison/time-series.js';

test('the default comparison retains the full historical window without relaxing exact accounting', () => {
  const daily = calendarDays('2025-10-01', '2026-10-14').map(day => ({ day,
    thorchain: contribution(100, day >= '2026-10-07' ? 0.47 : null),
    near: contribution(20, 200), chainflip: contribution(15, 10)
  }));
  const before = structuredClone(daily);
  const months = monthlyComparison(daily, { now: Date.parse('2026-10-14T12:00:00Z'), startDay: '2025-10-01' });
  const view = selectComparisonView(daily, months);
  assert.equal(view.fromDay, '2025-10-01', 'source gaps must not silently truncate every protocol to a few days');
  assert.equal(view.throughDay, '2026-10-13');
  assert.equal(view.mode, 'full');
  assert.equal(view.grain, 'month');
  assert.deepEqual(view.rows, daily, 'every original source day remains in the default view');
  assert.deepEqual(daily, before, 'selecting history must never rewrite accounting');
  assert.equal(view.rows[0].thorchain.netUsd, null, 'unknown subsidy cannot be fabricated as zero');
  assert.equal(view.rows.at(-1).thorchain.netUsd, 99.53);
});

test('full history displays labelled cached legacy values while latest verified excludes them', () => {
  const legacy = { method: 'midgard-earnings-residual-legacy-v1', incomeUsd: 100, reportedRewardUsd: -4, netUsd: 104 };
  const daily = ['2026-10-06', '2026-10-07', '2026-10-08'].map(day => ({ day,
    thorchain: { ...contribution(day === '2026-10-06' ? null : 98, day === '2026-10-06' ? null : 0.47),
      ...(day === '2026-10-06' ? { legacy } : {}) },
    near: contribution(20, 200), chainflip: contribution(15, 10)
  }));
  const before = structuredClone(daily);
  const full = selectComparisonView(daily, []);
  assert.equal(full.rows[0].thorchain.netUsd, 104);
  assert.equal(full.rows[0].thorchain.accounting, 'legacy');
  assert.equal(full.rows[1].thorchain.netUsd, 97.53);
  const verified = selectComparisonView(daily, [], { mode: 'verified' });
  assert.equal(verified.fromDay, '2026-10-07');
  assert.equal(verified.rows.length, 2);
  assert.deepEqual(daily, before);
});

test('all thirteen chart months return without changing the corrected October tail', () => {
  const daily = calendarDays('2025-10-01', '2026-10-14').map(day => ({ day,
    thorchain: day < '2026-10-07'
      ? { ...contribution(null, null), legacy: {
        method: 'midgard-earnings-residual-legacy-v1', incomeUsd: 100, reportedRewardUsd: -4, netUsd: 104
      } }
      : contribution(98, 0.47),
    near: contribution(20, 200), chainflip: contribution(15, 10)
  }));
  const view = selectComparisonView(daily, []);
  const months = monthlyComparison(view.rows, {
    now: Date.parse('2026-10-14T12:00:00Z'), startDay: '2025-10-01', endDay: '2026-10-14'
  });
  assert.equal(view.rows.length, 378);
  assert.equal(months.length, 13);
  assert.ok(months.every(month => month.protocols.thorchain.complete));
  assert.ok(months.slice(0, 12).every(month => month.protocols.thorchain.accounting === 'legacy'));
  const october = months.at(-1).protocols.thorchain;
  assert.equal(october.accounting, 'mixed');
  assert.equal(october.legacyDays, 6);
  assert.equal(october.correctedDays, 7);
  assert.ok(Math.abs(october.netUsd - (6 * 104 + 7 * 97.53)) < 1e-8);
  assert.deepEqual(view.rows.slice(-7), daily.slice(-7), 'the corrected tail is preserved verbatim');
});
