import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStreamingParamsFromMemo,
  isRapidSwapAction,
  normalizeRapidSwapAction,
  rankRapidSwapsByUsd
} from '../src/lib/rapid-swaps/model.js';

test('parseStreamingParamsFromMemo reads explicit rapid streaming params', () => {
  const details = parseStreamingParamsFromMemo('=:ETH.ETH:0xabc:2000000000/0/5');

  assert.deepEqual(details, {
    limit: '2000000000',
    interval: 0,
    quantity: 5,
    hasStreamingParams: true
  });
});

test('parseStreamingParamsFromMemo handles empty limit swaps', () => {
  const details = parseStreamingParamsFromMemo('=:ETH.ETH:0xabc:/1/1');

  assert.deepEqual(details, {
    limit: '',
    interval: 1,
    quantity: 1,
    hasStreamingParams: true
  });
});

test('isRapidSwapAction prefers streaming metadata when present', () => {
  const action = {
    status: 'success',
    height: '100',
    metadata: {
      swap: {
        memo: '=:BTC.BTC:bc1qexample:1000/5/4',
        streamingSwapMeta: {
          interval: '0',
          quantity: '4',
          count: '4',
          lastHeight: '101'
        }
      }
    }
  };

  // 4 subs in 2 blocks → truly rapid
  assert.equal(isRapidSwapAction(action), true);
});

test('isRapidSwapAction falls back to memo parsing', () => {
  const action = {
    status: 'success',
    metadata: {
      swap: {
        memo: '=:BTC.BTC:bc1qexample:1000/0/4'
      }
    }
  };

  // No height data → blocks_used=0, filter not applied
  assert.equal(isRapidSwapAction(action), true);
});

test('isRapidSwapAction rejects when subs <= blocks (interval=1 streaming)', () => {
  const action = {
    status: 'success',
    height: '100',
    metadata: {
      swap: {
        memo: '=:ETH.ETH:0xabc:0/0/5',
        streamingSwapMeta: {
          interval: '0',
          quantity: '5',
          count: '5',
          lastHeight: '104'
        }
      }
    }
  };

  // 5 subs in 5 blocks → one sub per block → not rapid
  assert.equal(isRapidSwapAction(action), false);
});

test('isRapidSwapAction accepts when subs > blocks (truly rapid)', () => {
  const action = {
    status: 'success',
    height: '100',
    metadata: {
      swap: {
        memo: '=:ETH.ETH:0xabc:0/0/10',
        streamingSwapMeta: {
          interval: '0',
          quantity: '10',
          count: '10',
          lastHeight: '102'
        }
      }
    }
  };

  // 10 subs in 3 blocks → truly rapid
  assert.equal(isRapidSwapAction(action), true);
});

test('normalizeRapidSwapAction extracts the recorded row shape', () => {
  const action = {
    date: '1773955124578368377',
    height: '100',
    status: 'success',
    txType: 'swap',
    in: [
      {
        address: 'bc1source',
        txID: 'ABC123',
        coins: [
          {
            asset: 'BTC.BTC',
            amount: '100000000'
          }
        ]
      }
    ],
    out: [
      {
        address: '0xdestination',
        coins: [
          {
            asset: 'ETH.ETH',
            amount: '200000000'
          }
        ]
      }
    ],
    metadata: {
      swap: {
        memo: '=:ETH.ETH:0xdestination:2000000000/0/5',
        liquidityFee: '12345',
        swapSlip: '42',
        streamingSwapMeta: {
          interval: '0',
          quantity: '5',
          count: '5',
          lastHeight: '101'
        }
      }
    }
  };

  const row = normalizeRapidSwapAction(action, {
    observedAt: '2026-03-19T20:00:00.000Z',
    priceIndex: {
      prices: new Map([
        ['BTC.BTC', 80000],
        ['ETH.ETH', 2000]
      ])
    }
  });

  assert.equal(row.tx_id, 'ABC123');
  assert.equal(row.source_asset, 'BTC.BTC');
  assert.equal(row.target_asset, 'ETH.ETH');
  assert.equal(row.streaming_interval, 0);
  assert.equal(row.streaming_quantity, 5);
  assert.equal(row.streaming_count, 5);
  assert.equal(row.input_estimated_usd, 80000);
  assert.equal(row.output_estimated_usd, 4000);
  assert.equal(row.destination_address, '0xdestination');
});

test('rankRapidSwapsByUsd sorts descending and limits the result', () => {
  const rows = [
    { tx_id: 'small', input_estimated_usd: 100, action_date: '2026-03-19T20:00:00.000Z' },
    { tx_id: 'large', input_estimated_usd: 500, action_date: '2026-03-19T19:00:00.000Z' },
    { tx_id: 'medium', input_estimated_usd: 250, action_date: '2026-03-19T18:00:00.000Z' }
  ];

  assert.deepEqual(
    rankRapidSwapsByUsd(rows, 2).map((row) => row.tx_id),
    ['large', 'medium']
  );
});
