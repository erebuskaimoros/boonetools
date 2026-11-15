import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBalance, getVisibleVaultCoins, summarizeVaultBalances, routerCheckStatus, balancesDelayed, SHORTFALL_TOLERANCE_BPS } from '../src/lib/vault-explorer/balances.js';
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

const verifiedCoin = (asset, amount, thornode_amount) => ({ asset, amount, thornode_amount, balance_status: 'verified', balance_expires_at: new Date(now + 60000).toISOString() });
test('fee-sized deficits under 1 bp of THORNode are tolerated, not alerted', () => {
  assert.equal(SHORTFALL_TOLERANCE_BPS, 1n);
  const dust = verifiedCoin('BCH.BCH', '169999946280', '170000000000');
  const state = describeBalance(dust, now);
  assert.equal(state.delta, '-53720');
  assert.equal(state.shortfall, false);
  assert.equal(state.withinTolerance, true);
  const summary = summarizeVaultBalances({ coins: [dust] }, {}, now);
  assert.equal(summary.shortfalls, 0);
  assert.equal(summary.withinTolerance, 1);
});
test('material and zero-balance deficits still alert, and tiny balances stay strict', () => {
  const zero = describeBalance(verifiedCoin('BTC.BTC', '0', '100'), now);
  assert.equal(zero.shortfall, true);
  assert.equal(zero.withinTolerance, false);
  assert.equal(describeBalance(verifiedCoin('BTC.BTC', '9998', '10000'), now).shortfall, true);
  // Exactly 1 bp is the boundary and is still tolerated.
  assert.equal(describeBalance(verifiedCoin('BTC.BTC', '9999', '10000'), now).withinTolerance, true);
  const equal = describeBalance(verifiedCoin('BTC.BTC', '10000', '10000'), now);
  assert.equal(equal.shortfall || equal.withinTolerance, false);
});
test('only material shortfalls sort to the top', () => {
  const dust = verifiedCoin('BTC.BTC', '99990965', '100000000');
  const big = verifiedCoin('ETH.ETH', '500000000', '500000000');
  const prices = { 'BTC.BTC': 1, 'ETH.ETH': 1 };
  assert.deepEqual(getVisibleVaultCoins({ coins: [dust, big] }, prices).map(c => c.asset), ['ETH.ETH', 'BTC.BTC']);
  const short = verifiedCoin('BTC.BTC', '0', '100');
  assert.deepEqual(getVisibleVaultCoins({ coins: [big, short] }, prices).map(c => c.asset), ['BTC.BTC', 'ETH.ETH']);
});
test('balances are delayed only when vault or L1 observations are missing or over 90 s old', () => {
  const at = ms => new Date(now - ms).toISOString();
  const meta = { vaults: { fetched_at: at(90_000) }, l1_balances: { fetched_at: at(60_000) }, nodes: { fetched_at: at(3_600_000) } };
  assert.equal(balancesDelayed(meta, now), false);
  assert.equal(balancesDelayed({ ...meta, l1_balances: { fetched_at: at(90_001) } }, now), true);
  assert.equal(balancesDelayed({ ...meta, vaults: { fetched_at: at(240_000) } }, now), true);
  assert.equal(balancesDelayed({ vaults: meta.vaults }, now), true);
  assert.equal(balancesDelayed({ ...meta, vaults: { fetched_at: 'not a date' } }, now), true);
  assert.equal(balancesDelayed(undefined, now), true);
});
