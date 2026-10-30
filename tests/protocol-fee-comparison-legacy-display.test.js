import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, contribution, monthlyComparison, THORCHAIN_LEGACY_METHOD } from '../shared/protocol-fee-comparison/model.js';
import { selectSummaryRows } from '../src/lib/charts/summary.js';
import * as comparison from '../src/lib/protocol-fee-comparison/time-series.js';

const now = Date.parse('2026-10-14T12:00:00Z');
const daily = calendarDays('2026-09-01', '2026-10-14').map(day => ({ day,
  thorchain: day < '2026-10-07'
    ? { ...contribution(null, null), grossIncomeUsd: 100,
      legacy: { method: THORCHAIN_LEGACY_METHOD, incomeUsd: 100, reportedRewardUsd: -4, netUsd: 104 } }
    : { ...contribution(98, 0.47), grossIncomeUsd: 100, revshareUsd: 2 },
  near: contribution(20, 200), chainflip: contribution(15, 10)
}));
const months = monthlyComparison(daily, { now, startDay: '2026-09-01' });

function chart(grain, rows = comparison.selectComparisonView(daily, months).rows) {
  return comparison.buildComparisonTimeSeries(rows, { nearNetSupply: true, thorchainRewardAccounting: true,
    analysis: { grain } });
}

test('historical daily tooltips show numbers without accounting labels while corrected deductions stay intact', () => {
  const before = structuredClone(daily);
  const option = chart('day');
  const legacy = option.tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(legacy, /Fees collected: \$100/);
  assert.match(legacy, /Deduction: -\$4/);
  assert.match(legacy, /Net: \$104/);
  assert.doesNotMatch(legacy, /legacy|mixed|not independently|not operating profit|whole-chain/i);
  assert.doesNotMatch(legacy, /Reserve emissions:|Retained fees:|REVSHARE paid:/);
  const corrected = option.tooltip.formatter([{ dataIndex: daily.length - 1 }]);
  assert.match(corrected, /Gross liquidity fees: \$100/);
  assert.match(corrected, /REVSHARE paid: \$2/);
  assert.match(corrected, /Retained fees: \$98/);
  assert.match(corrected, /Reserve emissions: \$0\.47/);
  assert.doesNotMatch(corrected, /LEGACY|MIXED|Midgard earnings residual/);
  assert.equal(option.series.find(item => item.id === 'thorchain').data.at(-1), 97.53);
  assert.deepEqual(daily, before);
});

test('weekly and monthly transition buckets retain the same numbers without accounting explainers', () => {
  for (const [grain, day, legacyDays, correctedDays] of [['week', '2026-10-05', 2, 5], ['month', '2026-10-01', 6, 7]]) {
    const option = chart(grain);
    const index = option._rows.findIndex(row => row.day === day);
    assert.ok(index >= 0);
    const tooltip = option.tooltip.formatter([{ dataIndex: index }]);
    assert.match(tooltip, /Fees collected:/);
    assert.match(tooltip, /Deduction:/);
    assert.match(tooltip, /Net:/);
    assert.doesNotMatch(tooltip, /legacy|mixed|not independently|not operating profit|whole-chain/i);
    assert.doesNotMatch(tooltip, /<br>Reserve emissions:|<br>REVSHARE paid:|<br>Retained fees:/);
    const net = option.series.find(item => item.id === 'thorchain').data[index];
    assert.ok(Math.abs(net - (legacyDays * 104 + correctedDays * 97.53)) < 1e-8);
  }
});

test('latest verified rejects projected legacy, mixed and old-snapshot accounting', () => {
  const projected = comparison.selectComparisonView(daily, months).rows;
  assert.equal(projected[0].thorchain.accounting, 'legacy');
  const verified = comparison.selectComparisonView(projected, months, { mode: 'verified' });
  assert.equal(verified.fromDay, '2026-10-07');
  assert.equal(verified.rows.length, 7);
  const older = daily.map(row => ({ ...row, thorchain: contribution(100, -4) }));
  assert.deepEqual(comparison.selectComparisonView(older, [], { mode: 'verified', correctedAccounting: false }).rows, []);
  const mixed = projected.map(row => ({ ...row, thorchain: { ...row.thorchain, accounting: 'mixed' } }));
  assert.deepEqual(comparison.selectComparisonView(mixed, [], { mode: 'verified' }).rows, []);
});

test('display months include the cutoff day and retain per-bucket legacy/corrected counts', () => {
  const display = comparison.comparisonDisplayMonths(daily, months, { now, throughDay: '2026-10-13' });
  assert.equal(display[0].protocols.thorchain.netUsd, 3120);
  assert.equal(display[0].protocols.thorchain.accounting, 'legacy');
  const october = display[1].protocols.thorchain;
  assert.equal(display[1].throughDay, '2026-10-13');
  assert.equal(october.accounting, 'mixed');
  assert.equal(october.legacyDays, 6);
  assert.equal(october.correctedDays, 7);
  assert.equal(october.observedDays, 13);
  assert.ok(Math.abs(october.netUsd - (6 * 104 + 7 * 97.53)) < 1e-8);
  assert.equal(months[1].protocols.thorchain.netUsd, null, 'canonical exact-only months are not rewritten');
  assert.deepEqual(comparison.comparisonDisplayMonths([], months, { now }), months);
  assert.deepEqual(comparison.selectComparisonView([], display, { mode: 'verified' }).rows, [], 'legacy and mixed monthly buckets are not corrected coverage');
});

test('summary accounting follows the selected daily range and native monthly counts', () => {
  const rows = comparison.selectComparisonView(daily, months).rows;
  assert.deepEqual(comparison.comparisonViewAccounting(rows), { accounting: 'mixed', legacyDays: 36, correctedDays: 7 });
  const exactTail = selectSummaryRows(rows, { startDay: '2026-10-07', endDay: '2026-10-13' });
  assert.deepEqual(comparison.comparisonViewAccounting(exactTail), { accounting: 'corrected', legacyDays: 0, correctedDays: 7 });
  const display = comparison.comparisonDisplayMonths(daily, months, { now });
  const monthly = display.map(row => ({ ...row, day: row.fromDay }));
  assert.deepEqual(comparison.comparisonViewAccounting(monthly, { sourceGrain: 'month' }), { accounting: 'mixed', legacyDays: 36, correctedDays: 7 });
  assert.deepEqual(comparison.comparisonViewAccounting(monthly, { sourceGrain: 'month', correctedAccounting: false }), { accounting: 'legacy', legacyDays: 43, correctedDays: 0 });
});
