import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionMatchesPair,
  actionOverlapsRange,
  calculatePairLegTotals,
  calculateRealizedFeeBps,
  extractSwapEvents,
  getEpochBlockRange,
  getPairFilterAsset,
  normalizeEpochTransactions
} from '../src/lib/dynamic-fees/transactions.js';

const pair = 'THOR.RUNE|THOR.TCY';

function swapAction({
  txId,
  height,
  lastHeight = height,
  pools = ['THOR.TCY'],
  status = 'success'
}) {
  return {
    date: '1784733021737170017',
    height: String(height),
    in: [{
      txID: txId,
      coins: [{ amount: '42706293373488', asset: 'THOR.TCY' }]
    }],
    out: [{
      coins: [{ amount: '10065948271231', asset: 'THOR.RUNE' }]
    }],
    pools,
    status,
    metadata: {
      swap: {
        inPriceUSD: '0.12',
        isStreamingSwap: lastHeight > height,
        liquidityFee: '3753831242',
        memo: '=:r:thor1destination:0/0/574:ss:60',
        swapSlip: '4',
        streamingSwapMeta: {
          lastHeight: String(lastHeight)
        }
      }
    }
  };
}

test('getEpochBlockRange maps sealed and live epochs to their protocol block windows', () => {
  assert.deepEqual(getEpochBlockRange(1883, 14400), {
    epoch: 1883,
    live: false,
    startHeight: 27100801,
    endHeight: 27115200
  });
  assert.deepEqual(getEpochBlockRange(1884, 14400, {
    live: true,
    currentBlockHeight: 27123679
  }), {
    epoch: 1884,
    live: true,
    startHeight: 27115201,
    endHeight: 27123679
  });
});

test('pair filtering uses the non-RUNE pool and accepts either canonical pair order', () => {
  assert.equal(getPairFilterAsset('THOR.TCY|THOR.RUNE'), 'THOR.TCY');
  assert.equal(getPairFilterAsset('THOR.RUNE|BTC.BTC'), 'BTC.BTC');
  assert.equal(actionMatchesPair(swapAction({ txId: 'A', height: 100 }), pair), true);
  assert.equal(actionMatchesPair(
    swapAction({ txId: 'B', height: 100, pools: ['ETH.ETH'] }),
    pair
  ), false);
});

test('streaming transactions are included when their execution window overlaps the epoch', () => {
  const range = getEpochBlockRange(10, 100);
  assert.equal(actionOverlapsRange(swapAction({
    txId: 'A',
    height: 895,
    lastHeight: 905
  }), range), true);
  assert.equal(actionOverlapsRange(swapAction({
    txId: 'B',
    height: 800,
    lastHeight: 900
  }), range), false);
  assert.equal(actionOverlapsRange(swapAction({
    txId: 'C',
    height: 1001,
    lastHeight: 1010
  }), range), false);
});

test('normalizeEpochTransactions filters, deduplicates, and sorts matching inbound txns', () => {
  const range = getEpochBlockRange(10, 100);
  const rows = normalizeEpochTransactions([
    swapAction({ txId: 'OLDER', height: 910 }),
    swapAction({ txId: 'NEWER', height: 990, lastHeight: 995, status: 'pending' }),
    swapAction({ txId: 'NEWER', height: 990, lastHeight: 995, status: 'pending' }),
    swapAction({ txId: 'OTHER-PAIR', height: 980, pools: ['BTC.BTC'] }),
    swapAction({ txId: 'OUTSIDE', height: 1001 })
  ], { pair, range });

  assert.deepEqual(rows.map((row) => row.txId), ['NEWER', 'OLDER']);
  assert.equal(rows[0].streaming, true);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].inputAsset, 'THOR.TCY');
  assert.equal(rows[0].outputAsset, 'THOR.RUNE');
  assert.equal(rows[0].inputUsd > 0, true);
  assert.equal(rows[0].liquidityFeeRune, 37.53831242);
  assert.equal(Math.abs(rows[0].realizedFeeBps - 3.7278473621162074) < 1e-12, true);
});

test('calculateRealizedFeeBps derives the collected rate instead of using reported swap slip', () => {
  const action = swapAction({ txId: 'RUNE-IN', height: 950 });
  action.in[0].coins[0] = { amount: '6200000000', asset: 'THOR.RUNE' };
  action.metadata.swap.liquidityFee = '2517503';
  action.metadata.swap.swapSlip = '4';

  assert.equal(
    Math.abs(calculateRealizedFeeBps(action) - 4.060488709677419) < 1e-12,
    true
  );
});

test('pair-leg fee math matches Thornode swap-event accounting and excludes affiliate conversion events', () => {
  const txId = '3DBB146F3C9FF2FA2F6641694835A7D47D7E2FF5C52942D92DA03857A449C5E4';
  const memo = '=:ETH.USDT:0x708a:0/0/149:ss:60';
  const event = (attributes) => ({
    type: 'swap',
    attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: String(value) }))
  });
  const swapEvents = extractSwapEvents({
    result: {
      finalize_block_events: [
        event({
          id: txId,
          pool: 'BTC.BTC',
          coin: '1035169 BTC.BTC',
          emit_asset: '160454240226 THOR.RUNE',
          liquidity_fee_in_rune: '48150717',
          memo
        }),
        event({
          id: txId,
          pool: 'ETH.USDT-0xabc',
          coin: '160454240226 THOR.RUNE',
          emit_asset: '66734408600 ETH.USDT-0xabc',
          liquidity_fee_in_rune: '48150815',
          memo
        }),
        event({
          id: txId,
          pool: 'BTC.BTC',
          coin: '1000 BTC.BTC',
          emit_asset: '900000 THOR.RUNE',
          liquidity_fee_in_rune: '9000',
          memo: 'affiliate:conversion'
        })
      ]
    }
  });
  const totals = calculatePairLegTotals(swapEvents, {
    pair: 'THOR.RUNE|BTC.BTC',
    txId,
    memo
  });
  const expectedBps = (48150717 / (160454240226 + 48150717)) * 10000;

  assert.equal(totals.eventCount, 1);
  assert.equal(totals.feeRuneBase, '48150717');
  assert.equal(totals.volumeRuneBase, '160502390943');
  assert.equal(Math.abs(totals.realizedFeeBps - expectedBps) < 1e-12, true);
});

test('normalizeEpochTransactions prefers exact selected-pair epoch totals when supplied', () => {
  const range = getEpochBlockRange(10, 100);
  const action = swapAction({ txId: 'PAIR-EXACT', height: 950 });
  const rows = normalizeEpochTransactions([action], {
    pair,
    range,
    pairLegTotalsByTxId: {
      'PAIR-EXACT': {
        eventCount: 3,
        feeRuneBase: '3000000',
        volumeRuneBase: '10000000000',
        realizedFeeBps: 3
      }
    }
  });

  assert.equal(rows[0].realizedFeeBps, 3);
  assert.equal(rows[0].liquidityFeeRune, 0.03);
  assert.equal(rows[0].pairVolumeRune, 100);
  assert.equal(rows[0].pairSwapEventCount, 3);
  assert.equal(rows[0].feeScope, 'selected_pair_epoch');
});
