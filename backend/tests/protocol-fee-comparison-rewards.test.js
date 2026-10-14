import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComparisonPayload, deriveComparisonDay } from '../src/protocol-fee-comparison/collector.js';

const accounting = (extra = {}) => ({ revshareE8: '500000000', reserveEmissionsE8: '100000000',
  from: Date.parse('2026-10-11') / 1000, through: Date.parse('2026-10-12') / 1000,
  complete: true, emissionsComplete: true, method: 'finalized-revshare-payouts', emissionsMethod: 'historical-reserve-formula-v1', ...extra });

test('THORChain deducts REVSHARE from fees and actual Reserve emissions once, not the signed Midgard residual', () => {
  const raw = { earnings: {
    liquidityFees: '10000000000', blockRewards: '-400000000', runePriceUSD: '2'
  }, rewardAccounting: accounting() };
  const before = structuredClone(raw);
  const result = deriveComparisonDay('2026-10-11', raw).thorchain;
  assert.equal(result.incomeUsd, 190, 'retained income excludes the affiliate revenue share');
  assert.equal(result.subsidyUsd, 2, 'a negative Midgard residual is not negative emissions');
  assert.equal(result.netUsd, 188, 'Reserve funding is deducted once after REVSHARE');
  assert.equal(result.grossIncomeUsd, 200);
  assert.equal(result.revshareUsd, 10);
  assert.deepEqual(raw, before, 'deriving corrected values must not mutate source observations');
});

test('THORChain rejects legacy residuals and incomplete or invalid exact reward observations', () => {
  const earnings = { liquidityFees: '10000000000', blockRewards: '-400000000', runePriceUSD: '2' };
  for (const rewardAccounting of [
    undefined, { reserveEmissionsE8: '0', revshareE8: '0' },
    accounting({ complete: false }), accounting({ method: 'estimate' }),
    accounting({ reserveEmissionsE8: '-100000000' }), accounting({ revshareE8: '-500000000' }),
    accounting({ reserveEmissionsE8: null }), accounting({ revshareE8: null }),
    accounting({ emissionsMethod: null }), accounting({ emissionsMethod: 'finalized-rewards-reconciliation' }),
    accounting({ emissionsMethod: 'unreviewed-formula' }), accounting({ emissionsComplete: false }),
    accounting({ from: Date.parse('2026-10-10') / 1000 }), accounting({ through: Date.parse('2026-10-11T12:00:00Z') / 1000 }),
    accounting({ revshareE8: '10000000001' }), accounting({ revshareE8: '1.5' })
  ]) {
    const result = deriveComparisonDay('2026-10-11', { earnings, rewardAccounting }).thorchain;
    assert.equal(result.netUsd, null);
    assert.equal(result.grossIncomeUsd, 200, 'observed gross fees remain available even while exact accounting is incomplete');
  }
});

test('REVSHARE-only evidence is disclosed but never used to invent actual Reserve emissions from a residual', () => {
  const raw = { earnings: { liquidityFees: '10000000000', blockRewards: '-400000000', runePriceUSD: '2' },
    rewardAccounting: accounting({ reserveEmissionsE8: undefined }) };
  const result = deriveComparisonDay('2026-10-11', raw).thorchain;
  assert.equal(result.grossIncomeUsd, 200);
  assert.equal(result.revshareUsd, 10);
  assert.equal(result.incomeUsd, 190);
  assert.equal(result.subsidyUsd, null);
  assert.equal(result.netUsd, null);
});

test('THORChain accounting gaps do not erase verified NEAR and Chainflip history or fabricate a zero subsidy', () => {
  const raw = { earnings: { liquidityFees: '10000000000', blockRewards: '-400000000', runePriceUSD: '2' },
    nearRevenue: 100, nearPrice: 2, wallets: { frontend_near: 1, other_near: 3 },
    nearNetIssuanceAtomic: '200000000000000000000000000', nearNetIssuanceMethod: 'onchain-utc-net-supply-v1',
    chainflipRevenue: 30, flipPrice: .5, flipIssuance: { atomic: '20000000000000000000' }
  };
  const cache = { version: 1, days: { '2026-10-01': raw } };
  const before = structuredClone(cache);
  const payload = buildComparisonPayload(cache, { now: Date.parse('2026-10-02'), startDay: '2026-10-01' });
  assert.equal(payload.throughDay, '2026-10-01');
  assert.equal(payload.months[0].protocols.thorchain.netUsd, null);
  assert.equal(payload.months[0].protocols.thorchain.subsidyUsd, null);
  assert.equal(payload.months[0].protocols.near.netUsd, -300);
  assert.equal(payload.months[0].protocols.chainflip.netUsd, 20);
  assert.deepEqual(payload.thorchainRewardAccounting, { complete: false, observedDays: 0, expectedDays: 1 });
  assert.equal(payload.stale, true);
  assert.deepEqual(cache, before);
});
