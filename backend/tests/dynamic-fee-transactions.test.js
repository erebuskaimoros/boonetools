import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDynamicFeeEpochTransactions,
  fetchDynamicFeeActions,
  getDynamicFeeEventHeights
} from '../src/shared/dynamic-fee-transactions.js';

function swapAction({
  txId = 'TX-1',
  height = 100,
  lastHeight = 101,
  memo = '=:ETH.USDT:destination:0/0/2:ss:60'
} = {}) {
  return {
    date: '1784733021737170017',
    height: String(height),
    in: [{
      txID: txId,
      coins: [{ amount: '2000000', asset: 'BTC.BTC' }]
    }],
    out: [{
      coins: [{ amount: '300000000', asset: 'ETH.USDT-0xabc' }]
    }],
    pools: ['BTC.BTC', 'ETH.USDT-0xabc'],
    status: 'success',
    metadata: {
      swap: {
        inPriceUSD: '60000',
        isStreamingSwap: lastHeight > height,
        liquidityFee: '120000',
        memo,
        streamingSwapMeta: { lastHeight: String(lastHeight) }
      }
    }
  };
}

function swapEvent(attributes) {
  return {
    type: 'swap',
    attributes: Object.entries(attributes).map(([key, value]) => ({
      key,
      value: String(value)
    }))
  };
}

test('getDynamicFeeEventHeights intersects streaming execution with the selected epoch', () => {
  const action = swapAction({ height: 95, lastHeight: 105 });
  assert.deepEqual(
    getDynamicFeeEventHeights(
      [action],
      'THOR.RUNE|BTC.BTC',
      { startHeight: 100, endHeight: 102 }
    ),
    [100, 101, 102]
  );
});

test('buildDynamicFeeEpochTransactions uses only selected-pair events in the selected epoch', async () => {
  const action = swapAction();
  const memo = action.metadata.swap.memo;
  const fetchedHeights = [];

  const result = await buildDynamicFeeEpochTransactions({
    actions: [action],
    pair: 'THOR.RUNE|BTC.BTC',
    range: { startHeight: 100, endHeight: 101 },
    fetchBlockResults: async (height) => {
      fetchedHeights.push(height);
      return {
        result: {
          finalize_block_events: [
            swapEvent({
              id: 'TX-1',
              pool: 'BTC.BTC',
              coin: '10000 BTC.BTC',
              emit_asset: '99970000 THOR.RUNE',
              liquidity_fee_in_rune: '30000',
              memo
            }),
            swapEvent({
              id: 'TX-1',
              pool: 'ETH.USDT-0xabc',
              coin: '99970000 THOR.RUNE',
              emit_asset: '500000 ETH.USDT-0xabc',
              liquidity_fee_in_rune: '30000',
              memo
            }),
            swapEvent({
              id: 'TX-1',
              pool: 'BTC.BTC',
              coin: '100 BTC.BTC',
              emit_asset: '900000 THOR.RUNE',
              liquidity_fee_in_rune: '9000',
              memo: 'affiliate:conversion'
            })
          ]
        }
      };
    }
  });

  assert.deepEqual(fetchedHeights, [100, 101]);
  assert.equal(result.scanned_block_count, 2);
  assert.equal(result.matched_swap_event_count, 2);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].feeScope, 'selected_pair_epoch');
  assert.equal(result.transactions[0].pairSwapEventCount, 2);
  assert.equal(Math.abs(result.transactions[0].realizedFeeBps - 3) < 1e-12, true);
});

test('fetchDynamicFeeActions follows opaque Midgard page tokens', async () => {
  const calls = [];
  const actions = await fetchDynamicFeeActions({
    affiliate: 'ss',
    asset: 'BTC.BTC',
    fromHeight: 100,
    toHeight: 200,
    fetchActions: async (params) => {
      calls.push(params);
      return params.prevPageToken
        ? { actions: [swapAction({ txId: 'TX-2', height: 102 })], meta: {} }
        : {
            actions: [swapAction({ txId: 'TX-1', height: 101 })],
            meta: { prevPageToken: 'opaque-token' }
          };
    }
  });

  assert.deepEqual(actions.map((action) => action.in[0].txID), ['TX-1', 'TX-2']);
  assert.equal(calls[1].prevPageToken, 'opaque-token');
  assert.equal(calls[1].fromHeight, undefined);
});
