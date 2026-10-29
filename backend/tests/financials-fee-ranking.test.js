import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceFinancialDay } from '../src/shared/financials-day-detail.js';

test('top swaps ranks fees before truncating, including a small swap outside the old volume top ten', async () => {
  const day = '2026-10-29', from = Date.parse(`${day}T00:00:00Z`) / 1000, through = from + 86400;
  const action = (id, volume, fee) => ({ type: 'swap', status: 'success', date: String(BigInt(from + 100) * 1000000000n),
    in: [{ txID: id, coins: [{ asset: 'THOR.RUNE', amount: String(volume * 1e8) }] }],
    out: [{ coins: [{ asset: 'BTC.BTC', amount: '100000000' }] }], pools: ['BTC.BTC'],
    metadata: { swap: { inPriceUSD: '0.5', liquidityFee: fee === null ? undefined : String(fee * 1e8) } } });
  const actions = [...Array.from({ length: 12 }, (_, index) => action(`large-${index}`, 10000 + index, 1)),
    action('small-high-fee', 500, 100), action('missing-fee', 1e6, null),
    { ...action('previous-day', 100, 1000), date: String(BigInt(from - 1) * 1000000000n) }];
  const initial = { day, from, to: through, through, phase: 'actions', swaps: [], pools: [], poolRows: [],
    tokens: [], pages: 0, unpriced: 0, pending: 0 };
  let { state } = await advanceFinancialDay(day, initial, async () => ({ actions }), through * 1000 + 60000);
  const { payload } = await advanceFinancialDay(day, state,
    async () => ({ intervals: [{ startTime: from, endTime: through, totalVolumeUSD: '1', totalVolume: '1' }] }),
    through * 1000 + 60000);
  assert.equal(payload.swaps.length, 10);
  assert.equal(payload.swaps[0].txId, 'SMALL-HIGH-FEE');
  assert.ok(!payload.swaps.some(row => row.txId === 'MISSING-FEE'));
  assert.ok(payload.swaps.every((row, index, rows) => !index || rows[index - 1].feeUsd >= row.feeUsd));
  assert.equal(payload.swapRankingBasis, 'liquidity-fees-usd');
});

test('USD fee ranking uses the price at each swap, and a known zero fee stays valid', async () => {
  const day = '2026-10-29', from = Date.parse(`${day}T00:00:00Z`) / 1000, through = from + 86400;
  const action = (id, at, fee, price) => ({ type: 'swap', status: 'success', date: String(BigInt(at) * 1000000000n),
    in: [{ txID: id, coins: [{ asset: 'THOR.RUNE', amount: '10000000000' }] }],
    out: [{ coins: [{ asset: 'BTC.BTC', amount: '1000000' }] }], pools: [],
    metadata: { swap: { inPriceUSD: String(price), liquidityFee: String(fee * 1e8) } } });
  const actions = [action('FEWER-RUNE-HIGHER-USD', from + 7200, 9, 2), action('MORE-RUNE-LOWER-USD', from + 3600, 10, 1),
    action('ZERO', from, 0, 1), action('OLD', from - 1, 1000, 100)];
  const initial = { day, from, to: through, through, phase: 'actions', swaps: [], pools: [], poolRows: [],
    tokens: [], pages: 0, unpriced: 0, pending: 0 };
  const { state } = await advanceFinancialDay(day, initial, async () => ({ actions }), through * 1000 + 60000);
  const { payload } = await advanceFinancialDay(day, state, () => assert.fail('no pool discovery needed'), through * 1000 + 60000);
  assert.deepEqual(payload.swaps.map(row => [row.txId, row.feeUsd]), [
    ['FEWER-RUNE-HIGHER-USD', 18], ['MORE-RUNE-LOWER-USD', 10], ['ZERO', 0]
  ]);
  assert.equal(payload.unpricedSwaps, 0);
});
