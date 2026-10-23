import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTcPoolFees, tcFeePoolBucket } from '../../shared/tc-fee-composition.js';
import { buildTcFeeComposition } from '../src/shared/tc-fee-composition.js';

const pool = (pool, rune, extra = {}) => ({ pool, totalLiquidityFeesRune: String(rune * 1e8), ...extra });
const pools = [pool('BTC.BTC', 40), pool('ETH.ETH', 20), pool('ETH.USDC-0X123', 10), pool('TRON.USDT-TOKEN', 20), pool('LTC.LTC', 10)];

test('four mutually exclusive buckets distinguish native pools from tokens and stablecoins on all chains', () => {
  for (const asset of ['BTC.BTC', 'btc.btc']) assert.equal(tcFeePoolBucket(asset), 'btc');
  assert.equal(tcFeePoolBucket('ETH.ETH'), 'eth');
  for (const symbol of ['USDT', 'USDC', 'DAI', 'GUSD', 'LUSD', 'USDP', 'BUSD']) {
    for (const chain of ['ETH', 'AVAX', 'BASE', 'BSC', 'TRON', 'BNB']) assert.equal(tcFeePoolBucket(`${chain}.${symbol}-TOKEN`), 'stablecoins');
  }
  for (const asset of ['ETH.WBTC-0X123', 'BASE.ETH', 'BSC.ETH-0X123', 'ETH.LINK-0X123', 'BCH.BCH']) assert.equal(tcFeePoolBucket(asset), 'other');
});

test('fee attribution uses liquidity fees, not pool rewards, and sums to the existing USD total', () => {
  const fees = reconcileTcPoolFees(pools.map(row => ({ ...row, rewards: '99999999999999', earnings: '99999999999999' })), '100', '50');
  assert.deepEqual(fees, { btc: 20, eth: 10, stablecoins: 15, other: 5 });
  assert.equal(Object.values(fees).reduce((a, b) => a + b, 0), 50);
});

test('missing, duplicate, partial, invalid and unreconciled history is not reclassified as other', () => {
  for (const candidate of [undefined, [], [null], ['invalid'], pools.slice(1), [...pools, pools[0]], pools.map((row, index) => index ? row : { ...row, partial: true }), [pool('BTC.BTC', -1)]]) {
    assert.equal(reconcileTcPoolFees(candidate, '100', 50), null);
  }
  assert.equal(reconcileTcPoolFees(pools, '101', 50), null);
  assert.equal(reconcileTcPoolFees(pools, '99', 50), null);
  assert.equal(reconcileTcPoolFees(pools, '100', null), null);
  assert.equal(reconcileTcPoolFees(pools, '100', NaN), null);
  assert.equal(reconcileTcPoolFees(pools, '100', 0), null);
});

test('zero-fee days remain known zeros and rounding cannot conceal real gaps', () => {
  assert.deepEqual(reconcileTcPoolFees([pool('BTC.BTC', 0)], '0', 0), { btc: 0, eth: 0, stablecoins: 0, other: 0 });
  assert.equal(reconcileTcPoolFees([pool('BTC.BTC', 0)], '0.00000001', 1), null);
  assert.ok(reconcileTcPoolFees(pools, '100.00000001', 50));
  assert.equal(reconcileTcPoolFees(pools, '100.000001', 50), null);
});

test('cached full earnings retains retired stablecoin pools; pool history is a reconciled fallback', async () => {
  const calls = [];
  const windows = ['2026-01-01', '2026-01-02', '2026-01-03'].map(window_start => ({
    period: 'day', window_start, tc_fees_rune: '100', tc_fees_usd: '50'
  }));
  windows[0].earnings_pools = [pool('BNB.BUSD-ABC', 100)];
  const result = await buildTcFeeComposition({ query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ day: '2026-01-02', pools, updated_at: '2026-01-04T00:00:00Z' }] };
  } }, windows);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['2026-01-01', '2026-01-03']);
  assert.match(calls[0].sql, /pool_analysis_daily/);
  assert.equal(result.rows[0].fees.stablecoins, 50);
  assert.equal(result.rows[0].source, 'cached-earnings');
  assert.equal(result.rows[1].source, 'cached-pool-history');
  assert.equal(result.rows[2].fees, null);
  assert.equal(result.rows[2].complete, false);
  assert.equal(result.sourceUpdatedAt, '2026-01-04T00:00:00.000Z');
});

test('legacy weekly seeds do not fabricate daily pool attribution', async () => {
  const result = await buildTcFeeComposition({ query() { throw new Error('Unexpected query'); } }, [{ period: 'weekly_seed' }]);
  assert.deepEqual(result.rows, []);
});

test('current UTC day is explicitly partial; no unavailable USD value becomes zero', async () => {
  const result = await buildTcFeeComposition({ query: async () => ({ rows: [] }) }, [
    { period: 'day', window_start: '2026-10-21', tc_fees_rune: '100', tc_fees_usd: null },
    { period: 'day', window_start: '2026-10-22', tc_fees_rune: '100', tc_fees_usd: 50, earnings_pools: pools }
  ], { now: Date.parse('2026-10-22T18:00:00Z') });
  assert.equal(result.rows[0].partial, false);
  assert.equal(result.rows[0].totalFeesUsd, null);
  assert.equal(result.rows[0].complete, false);
  assert.equal(result.rows[1].partial, true);
  assert.equal(result.rows[1].complete, true);
});
