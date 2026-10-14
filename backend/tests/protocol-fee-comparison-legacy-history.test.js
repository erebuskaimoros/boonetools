import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComparisonPayload, deriveComparisonDay } from '../src/protocol-fee-comparison/collector.js';
import { calendarDays, comparisonAccountingSummary, comparisonDisplayDay, monthlyComparison,
  THORCHAIN_CORRECTED_FROM_DAY, THORCHAIN_LEGACY_METHOD } from '../../shared/protocol-fee-comparison/model.js';

const earnings = { liquidityFees: '10000000000', blockRewards: '-400000000', runePriceUSD: '2' };

test('cached pre-correction history is restored separately from exact Reserve accounting', () => {
  const raw = { earnings };
  const before = structuredClone(raw);
  const point = deriveComparisonDay('2026-10-06', raw).thorchain;
  assert.equal(point.netUsd, null, 'legacy history must never masquerade as corrected accounting');
  assert.deepEqual(point.legacy, {
    method: 'midgard-earnings-residual-legacy-v1', incomeUsd: 200,
    reportedRewardUsd: -8, netUsd: 208
  });
  assert.deepEqual(raw, before, 'saved source observations remain unchanged');
});

test('legacy history never fills a missing corrected day on or after October 7', () => {
  for (const day of ['2026-10-07', '2026-10-13', '2026-10-14']) {
    const point = deriveComparisonDay(day, { earnings }).thorchain;
    assert.equal(point.netUsd, null);
    assert.equal(point.legacy, undefined);
  }
});

test('legacy restoration requires every saved input and preserves signed residuals', () => {
  for (const invalid of [
    { blockRewards: null }, { blockRewards: '' }, { blockRewards: 'bad' },
    { blockRewards: ' ' }, { blockRewards: false }, { blockRewards: '1.2' },
    { liquidityFees: null }, { liquidityFees: '-1' }, { liquidityFees: '1.2' },
    { runePriceUSD: '0' }, { runePriceUSD: Infinity }, { runePriceUSD: null },
    { runePriceUSD: Number.MAX_VALUE }
  ]) assert.equal(deriveComparisonDay('2026-10-06', { earnings: { ...earnings, ...invalid } }).thorchain.legacy, undefined);
  const zero = deriveComparisonDay('2026-10-06', { earnings: { ...earnings, blockRewards: '0' } }).thorchain.legacy;
  assert.equal(zero?.reportedRewardUsd, 0);
  assert.equal(zero?.netUsd, 200);
});

test('display projection restores only valid legacy data and never mutates canonical rows', () => {
  assert.equal(THORCHAIN_CORRECTED_FROM_DAY, '2026-10-07');
  assert.equal(THORCHAIN_LEGACY_METHOD, 'midgard-earnings-residual-legacy-v1');
  const row = deriveComparisonDay('2026-10-06', { earnings });
  const original = structuredClone(row);
  Object.freeze(row.thorchain.legacy);
  Object.freeze(row.thorchain);
  Object.freeze(row);
  const display = comparisonDisplayDay(row);
  assert.notEqual(display, row);
  assert.notEqual(display.thorchain, row.thorchain);
  assert.equal(display.thorchain.accounting, 'legacy');
  assert.equal(display.thorchain.incomeUsd, 200);
  assert.equal(display.thorchain.grossIncomeUsd, 200);
  assert.equal(display.thorchain.subsidyUsd, -8);
  assert.equal(display.thorchain.netUsd, 208);
  assert.equal(display.thorchain.revshareUsd, null, 'legacy projection cannot fabricate verified REVSHARE');
  assert.deepEqual(row, original);
  const negative = comparisonDisplayDay(deriveComparisonDay('2026-10-06', {
    earnings: { ...earnings, blockRewards: '12000000000' }
  }));
  assert.equal(negative.thorchain.subsidyUsd, 240);
  assert.equal(negative.thorchain.netUsd, -40);
});

test('corrected values take priority even before cutoff and forged later legacy values are ignored', () => {
  const row = deriveComparisonDay('2026-10-06', { earnings });
  for (const netUsd of [0, -10, 188]) {
    const exact = { ...row, thorchain: { ...row.thorchain, incomeUsd: 190, subsidyUsd: 2, netUsd } };
    assert.deepEqual(comparisonDisplayDay(exact), exact);
  }
  for (const day of ['2026-10-07', '2026-10-14']) {
    const forged = { ...row, day };
    assert.deepEqual(comparisonDisplayDay(forged), forged);
    assert.equal(comparisonDisplayDay(forged).thorchain.netUsd, null);
  }
  for (const invalid of [
    { method: 'other' }, { incomeUsd: null }, { incomeUsd: -1 }, { incomeUsd: false },
    { reportedRewardUsd: '' }, { reportedRewardUsd: Infinity }, { netUsd: null }, { netUsd: NaN }
  ]) {
    const candidate = { ...row, thorchain: { ...row.thorchain, legacy: { ...row.thorchain.legacy, ...invalid } } };
    assert.deepEqual(comparisonDisplayDay(candidate), candidate);
  }
});

test('accounting summaries count available days only and retain real zero', () => {
  assert.deepEqual(comparisonAccountingSummary([]), { accounting: 'corrected', legacyDays: 0, correctedDays: 0 });
  assert.deepEqual(comparisonAccountingSummary([
    { accounting: 'legacy', netUsd: -4 }, { accounting: 'legacy', netUsd: 0 },
    { accounting: 'legacy', netUsd: null }, undefined
  ]), { accounting: 'legacy', legacyDays: 2, correctedDays: 0 });
  assert.deepEqual(comparisonAccountingSummary([
    { accounting: 'legacy', netUsd: 12 }, { netUsd: 0 }, { accounting: 'corrected', netUsd: -10 },
    { netUsd: Infinity }, { accounting: 'legacy', netUsd: '' }
  ]), { accounting: 'mixed', legacyDays: 1, correctedDays: 2 });
});

test('display months can mix legacy and corrected days without changing canonical payloads or verified coverage', () => {
  const days = calendarDays('2026-10-01', '2026-10-09');
  const cache = { version: 1, days: Object.fromEntries(days.map(day => [day, {
    earnings: { ...earnings }, nearRevenue: 100, nearPrice: 2,
    wallets: { frontend_near: 1, other_near: 3 },
    nearNetIssuanceAtomic: '200000000000000000000000000', nearNetIssuanceMethod: 'onchain-utc-net-supply-v1',
    chainflipRevenue: 30, flipPrice: .5, flipIssuance: { atomic: '20000000000000000000' },
    ...(day >= THORCHAIN_CORRECTED_FROM_DAY ? { rewardAccounting: {
      from: Date.parse(day) / 1000, through: Date.parse(day) / 1000 + 86400,
      complete: true, emissionsComplete: true, method: 'finalized-revshare-payouts',
      emissionsMethod: 'historical-reserve-formula-v1', revshareE8: '500000000', reserveEmissionsE8: '100000000'
    } } : {})
  }])) };
  const before = structuredClone(cache);
  const options = { now: Date.parse('2026-10-09T12:00:00Z'), startDay: '2026-10-01' };
  const payload = buildComparisonPayload(cache, options);
  const canonical = structuredClone(payload);
  assert.equal(payload.methodology, 'retained-swap-income-less-network-subsidy-v4');
  assert.equal(payload.months[0].protocols.thorchain.netUsd, null);
  assert.deepEqual(payload.thorchainRewardAccounting, { complete: false, observedDays: 2, expectedDays: 8 });
  assert.equal(payload.months[0].protocols.thorchain.legacyDays, 0);
  assert.equal(payload.months[0].protocols.thorchain.correctedDays, 2);
  const [month] = monthlyComparison(payload.daily.map(comparisonDisplayDay), { ...options, endDay: '2026-10-09' });
  assert.equal(month.protocols.thorchain.netUsd, 6 * 208 + 2 * 188);
  assert.equal(month.protocols.thorchain.complete, true);
  assert.equal(month.protocols.thorchain.accounting, 'mixed');
  assert.equal(month.protocols.thorchain.legacyDays, 6);
  assert.equal(month.protocols.thorchain.correctedDays, 2);
  assert.deepEqual(month.protocols.near, payload.months[0].protocols.near);
  assert.deepEqual(month.protocols.chainflip, payload.months[0].protocols.chainflip);
  assert.deepEqual(payload, canonical);
  assert.deepEqual(cache, before);
  assert.deepEqual(buildComparisonPayload(cache, options), payload, 'cached data is enough to rebuild without acquisition');
});
