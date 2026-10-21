import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChurnHistory,
  churnCsvRows,
  combineChurnHistories,
  isBondEvent,
  mergeBondTxMaps
} from '../src/lib/position-tracker/bond-history.js';

const DAY = 86400;
const row = (height, day, stack, bond, price = 1) => ({
  churn_height: height,
  churn_timestamp: day * DAY,
  rune_stack: stack * 1e8,
  user_bond: bond == null ? null : bond * 1e8,
  rune_price: price
});

test('splits each churn into reward and the user\'s own bond change', () => {
  const history = buildChurnHistory([
    row(100, 1, 1000, 1000),
    row(200, 4, 1010, 1000),
    row(300, 7, 1520, 1500)
  ]);
  assert.deepEqual(history.map((entry) => entry.reward / 1e8), [0, 10, 20]);
  assert.deepEqual(history.map((entry) => entry.bondChange / 1e8), [0, 0, 490]);
  assert.equal(history[2].usdValue, 1520);
  assert.ok(history[1].apy > 0 && history[0].apy === 0);
  assert.ok(isBondEvent(history[2].bondChange) && !isBondEvent(history[1].bondChange));
});

test('a single address passes through unchanged', () => {
  const history = buildChurnHistory([row(100, 1, 1000, 1000), row(200, 4, 1010, 1000)]);
  assert.equal(combineChurnHistories([history, []]), history);
});

test('portfolio history sums stacks by churn height and keeps lagging addresses', () => {
  const a = buildChurnHistory([row(100, 1, 1000, 1000), row(200, 4, 1010, 1000), row(300, 7, 1020, 1010)]);
  // B starts a churn later (a bond event for the portfolio) and its history lags one churn.
  const b = buildChurnHistory([row(200, 4, 50, 50, 1), row(250, 5, 51, 50, 1)]);
  const combined = combineChurnHistories([a, b]);

  assert.deepEqual(combined.map((entry) => entry.height), [100, 200, 250, 300]);
  assert.deepEqual(combined.map((entry) => entry.runeStack / 1e8), [1000, 1060, 1061, 1071]);
  assert.deepEqual(combined.map((entry) => entry.bondChange / 1e8), [0, 50, 0, 0]);
  assert.deepEqual(combined.map((entry) => entry.reward / 1e8), [0, 10, 1, 10]);
  assert.equal(combined[3].usdValue, 1071);
});

test('merges bond transaction maps and exports newest churn first', () => {
  assert.deepEqual(mergeBondTxMaps([{ 200: ['A'] }, { 200: ['B'], 300: ['C'] }]), { 200: ['A', 'B'], 300: ['C'] });
  const rows = churnCsvRows(buildChurnHistory([row(100, 1, 1000, 1000), row(200, 4, 1010, 1000)]));
  assert.equal(rows[0].reward_rune, '10.0000');
  assert.equal(rows[1].date, '1970-01-02');
});

test('operator payouts stay separate from bonded rewards, stack and APY', () => {
  const rows = [row(100, 1, 1000, 1000), row(200, 4, 1010, 1000)];
  const base = buildChurnHistory(rows);
  const operator = buildChurnHistory(rows.map((entry) => ({ ...entry, operator_fee: 5e8 })));
  assert.deepEqual(operator.map(({ operatorFee, ...entry }) => entry), base.map(({ operatorFee, ...entry }) => entry));
  assert.deepEqual(operator.map((entry) => entry.operatorFee), [5e8, 5e8]);
  const combined = combineChurnHistories([operator, buildChurnHistory(rows.map((entry) => ({ ...entry, operator_fee: 2e8 })))]);
  assert.deepEqual(combined.map((entry) => entry.operatorFee), [7e8, 7e8]);
  assert.equal(combined[1].reward, 20e8);
});

test('missing or lagging operator payouts stay unavailable instead of carrying forward or becoming zero', () => {
  const a = buildChurnHistory([{ ...row(100, 1, 1000, 1000), operator_fee: 5e8 }, { ...row(200, 4, 1010, 1000), operator_fee: 0 }]);
  const b = buildChurnHistory([{ ...row(100, 1, 100, 100), operator_fee: 2e8 }]);
  assert.deepEqual(combineChurnHistories([a, b]).map((entry) => entry.operatorFee), [7e8, null]);
  const unknown = buildChurnHistory([row(100, 1, 100, 100)]);
  assert.equal(combineChurnHistories([a, unknown])[0].operatorFee, null);
});

test('exports operator payouts only when relevant, with blank unknowns and explicit zero', () => {
  const history = buildChurnHistory([
    row(100, 1, 1000, 1000), { ...row(200, 4, 1010, 1000), operator_fee: 0 },
    { ...row(300, 7, 1020, 1010), operator_fee: 5e8 }
  ]);
  assert.deepEqual(churnCsvRows(history).map((entry) => entry.operator_fee_rune), ['5.0000', '0.0000', '']);
  assert.ok(!Object.hasOwn(churnCsvRows(history, false)[0], 'operator_fee_rune'));
  assert.equal(churnCsvRows(history.slice(0, 1), true)[0].operator_fee_rune, '');
});
