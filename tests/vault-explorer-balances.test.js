import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBalance, getVisibleVaultCoins, summarizeVaultBalances, routerCheckStatus } from '../src/lib/vault-explorer/balances.js';
const now = Date.parse('2026-09-26T12:00:00Z');
const drained = { asset: 'BTC.BTC', amount: '0', thornode_amount: '100000000', balance_status: 'verified', balance_expires_at: new Date(now + 60000).toISOString() };

test('a drained or unpriced asset stays visible and reports its missing amount', () => {
  assert.equal(getVisibleVaultCoins({ coins: [drained] }).length, 1);
  assert.equal(describeBalance(drained, now).delta, '-100000000');
  assert.equal(summarizeVaultBalances({ coins: [drained] }, {}, now).shortfalls, 1);
});
test('THORNode fallback is never displayed or summed as an L1 balance', () => {
  const coin = { asset: 'BTC.BTC', amount: '100000000', balance_status: 'unavailable' };
  assert.equal(describeBalance(coin, now).amount, null);
  assert.equal(describeBalance(coin, now).expected, '100000000');
  assert.equal(summarizeVaultBalances({ coins: [coin] }, { 'BTC.BTC': 50000 }, now).valueUSD, 0);
});
test('freshness expires on the client even without a new snapshot', () => {
  assert.equal(describeBalance(drained, now + 60001).state, 'stale');
  const summary = summarizeVaultBalances({ coins: [drained] }, {}, now + 60001);
  assert.equal(summary.fresh, 0);
  assert.equal(summary.stale, 1);
  assert.equal(summary.shortfalls, 0);
  assert.equal(routerCheckStatus({ status: 'covered', observed_at: new Date(now).toISOString() }, now + 90001), 'stale');
});
test('legacy snapshots remain explicitly THORNode-only until backend rollout', () => {
  assert.equal(describeBalance({ asset: 'LTC.LTC', amount: '10' }, now).label, 'THORNode only');
});
