import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialsPoints, buildLiveFinancialsPoint, daySeconds } from '../../shared/financials/model.js';

const day = '2026-10-11';
const from = daySeconds(day);
const earnings = { earnings: '9700000000', liquidityFees: '10000000000', blockRewards: '-300000000',
  bondingEarnings: '4000000000', runePriceUSD: '2' };
const evidence = { from, through: from + 86400, revshareE8: '500000000', reserveEmissionsE8: '200000000',
  complete: true, emissionsComplete: true, method: 'finalized-revshare-payouts', emissionsMethod: 'historical-reserve-formula-v1' };
function point(source = evidence, income = earnings) {
  return buildFinancialsPoints({ from, to: from + 86400,
    earnings: [{ ...income, startTime: String(from), endTime: String(from + 86400) }],
    rewardAccounting: { [day]: source } })[0];
}

test('gross income, exact emissions and REVSHARE reconcile without treating the residual as emissions', () => {
  const row = point();
  assert.equal(row.reserveEmissionsRune, 2);
  assert.equal(row.revshareRune, 5);
  assert.equal(row.grossIncomeRune, 102);
  assert.equal(row.grossIncomeUsd, 204);
  assert.equal(row.incomeRune, 97);
  assert.equal(row.reconciliationAdjustmentRune, 0);
  assert.equal(row.midgardResidualRune, -3);
});

test('a source discrepancy stays separate from nonnegative emissions and real payouts', () => {
  const row = point(evidence, { ...earnings, earnings: '9600000000', blockRewards: '-400000000' });
  assert.equal(row.reserveEmissionsRune, 2);
  assert.equal(row.revshareRune, 5);
  assert.equal(row.reconciliationAdjustmentRune, -1);
  assert.equal(row.incomeRune, 96);
});

test('missing or mismatched evidence never turns into zero or a residual-based emission estimate', () => {
  for (const source of [null, {}, { ...evidence, complete: false }, { ...evidence, method: 'midgard-residual' },
    { ...evidence, through: from + 300 }]) {
    assert.equal(point(source).revshareRune, null);
    assert.equal(point(source).reserveEmissionsRune, null);
    assert.equal(point(source).reconciliationAdjustmentRune, null);
  }
  const partial = point({ ...evidence, reserveEmissionsE8: null, emissionsComplete: false });
  assert.equal(partial.revshareRune, 5);
  assert.equal(partial.reserveEmissionsRune, null);
  assert.equal(partial.grossIncomeRune, null);
  for (const invalid of ['-1', '1.5', 'NaN']) assert.equal(point({ ...evidence, reserveEmissionsE8: invalid }).reserveEmissionsRune, null);
  assert.equal(point({ ...evidence, revshareE8: '0', reserveEmissionsE8: '0' }).reserveEmissionsRune, 0);
});

test('live source coverage is matched to the same five-minute cutoff, not the latest chain tip', () => {
  const through = from + 600;
  const row = buildLiveFinancialsPoint({ from, through, earnings, rewardAccounting: { ...evidence, through } });
  assert.equal(row.revshareRune, 5);
  assert.equal(row.reserveEmissionsRune, 2);
  assert.equal(buildLiveFinancialsPoint({ from, through, earnings, rewardAccounting: evidence }).revshareRune, null);
});
