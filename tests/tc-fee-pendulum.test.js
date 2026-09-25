import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIncentivePendulum, buildSystemIncomeDistribution, systemIncomeDistributionFlows } from '../src/lib/tc-fee-dash/distribution.js';

const atoms = rune => String(BigInt(rune) * 100000000n);
const nodes = (bonds = [33, 33, 33]) => bonds.map(bond => ({ status: 'Active', total_bond: atoms(bond) }));
const network = { available_pools_rune: atoms(22), vaults_liquidity_rune: atoms(33) };
const constants = { int_64_values: {
  PendulumAssetsBasisPoints: 10000, PendulumUseEffectiveSecurity: 0, PendulumUseVaultAssets: 0,
  SystemIncomeBurnRateBps: 100, DevFundSystemIncomeBps: 500, TCYStakeSystemIncomeBps: 1000,
  MarketingFundSystemIncomeBps: 500, POLReserveSystemIncomeBps: 2000
} };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('pendulum matches all four official effective-security/vault-asset examples', () => {
  for (const [security, vaults, lpFraction] of [[0, 0, 7 / 9], [1, 0, 4 / 7], [0, 1, 4 / 7], [1, 1, 4 / 13]]) {
    const result = calculateIncentivePendulum({
      PENDULUMUSEEFFECTIVESECURITY: security, PENDULUMUSEVAULTASSETS: vaults
    }, constants, network, nodes());
    assert.equal(result.available, true);
    close(result.lpFraction, lpFraction);
    close(result.bondFraction + result.lpFraction, 1);
  }
});

test('hard cap uses ceil(2N/3), excludes inactive nodes and keeps exact large atomic bonds', () => {
  const active = nodes([10, 20, 90]);
  const before = JSON.stringify(active);
  const result = calculateIncentivePendulum({}, constants, network, [...active, { status: 'Standby', total_bond: atoms(9000) }]);
  assert.equal(result.bondHardCap, atoms(20));
  assert.equal(result.effectiveSecurityBond, atoms(30));
  assert.equal(result.totalEffectiveBond, atoms(50));
  assert.equal(JSON.stringify(active), before);
  assert.equal(calculateIncentivePendulum({}, constants, network, nodes([10, 20, 30, 90])).totalEffectiveBond, atoms(90));
  const big = 9007199254740993n;
  const large = calculateIncentivePendulum({}, constants, network,
    [big, big + 2n, big * 10n].map(value => ({ status: 'Active', total_bond: String(value) })));
  assert.equal(large.totalEffectiveBond, String(big * 3n + 4n));
});

test('assets multiplier, security boundary and zero overrides follow the pendulum', () => {
  const under = { ...network, available_pools_rune: atoms(66) };
  assert.equal(calculateIncentivePendulum({ PENDULUMUSEEFFECTIVESECURITY: 1 }, constants, under, nodes()).lpFraction, 0);
  assert.equal(calculateIncentivePendulum({ PENDULUMASSETSBASISPOINTS: 0 }, constants, network, nodes()).lpFraction, 1);
  assert.equal(calculateIncentivePendulum({ PENDULUMASSETSBASISPOINTS: 50000 }, constants, network, nodes()).lpFraction, 0);
  const override = { ...constants, int_64_values: { ...constants.int_64_values, PendulumUseEffectiveSecurity: 1 } };
  close(calculateIncentivePendulum({ pendulumuseeffectivesecurity: 0 }, override, network, nodes()).lpFraction, 7 / 9);
});

test('missing inputs fail closed, including an incomplete active-node bond list', () => {
  for (const [config, net, roster] of [
    [{}, network, nodes()], [constants, {}, nodes()], [constants, network, []],
    [constants, network, [{ status: 'Active', total_bond: null }]],
    [constants, network, [{ status: 'Active', total_bond: Number.MAX_SAFE_INTEGER + 1 }]],
    [constants, { available_pools_rune: atoms(22) }, nodes()]
  ]) {
    // Vault liquidity is required only when that setting is enabled.
    const result = calculateIncentivePendulum({ PENDULUMUSEVAULTASSETS: 1 }, config, net, roster);
    assert.equal(result.available, false);
    assert.equal(result.lpFraction, null);
  }
  const unknown = buildSystemIncomeDistribution({}, constants);
  assert.equal(unknown.complete, false);
  assert.ok(unknown.allocations.filter(row => ['bond', 'lp'].includes(row.id)).every(row => row.percent === null));
  assert.deepEqual(systemIncomeDistributionFlows(unknown), []);
});

test('post-revshare fixed lanes plus bonders and LPs total 100 percent without double-counting POL', () => {
  const result = buildSystemIncomeDistribution({ PENDULUMUSEEFFECTIVESECURITY: 1 }, constants, network, nodes());
  assert.equal(result.complete, true);
  assert.equal(result.explicitBps, 4100);
  const byId = Object.fromEntries(result.allocations.map(row => [row.id, row]));
  close(byId.lp.percent, 59 * 4 / 7);
  close(byId.bond.percent, 59 * 3 / 7);
  assert.equal(byId.pol.percent, 20);
  close(result.allocations.reduce((sum, row) => sum + row.percent, 0), 100);
  const flows = systemIncomeDistributionFlows(result);
  assert.equal(flows.find(row => row.to === 'LPs').flow, byId.lp.percent);
  close(flows.reduce((sum, row) => sum + row.flow, 0), 100);
});

test('zero LP allocation stays in the table but does not fabricate a nonzero Sankey flow', () => {
  const result = buildSystemIncomeDistribution({}, constants, { ...network, available_pools_rune: atoms(100) }, nodes());
  assert.equal(result.allocations.find(row => row.id === 'lp').percent, 0);
  assert.ok(!systemIncomeDistributionFlows(result).some(row => row.to === 'LPs'));
  const overflow = buildSystemIncomeDistribution({ SYSTEMINCOMEBURNRATEBPS: 10000 }, constants, network, nodes());
  assert.equal(overflow.complete, false);
  assert.ok(overflow.overflowBps > 0);
  assert.deepEqual(systemIncomeDistributionFlows(overflow), []);
});
