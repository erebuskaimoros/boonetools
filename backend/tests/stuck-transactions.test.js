import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyStuckTransactions } from '../src/shared/stuck-transactions.js';

const TX_ID = 'CF8793762848DD0712843397786D8AAB635D94F74334DDC86E1730B071BC0A80';
const MAIN_COIN = {
  asset: 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T',
  amount: '111397538000'
};

function baseInput(overrides = {}) {
  return {
    outboundQueue: [{
      height: 9900,
      in_hash: TX_ID,
      chain: 'TRON',
      to_address: 'TLe4fXH3X6yBeM13xKuhkiZ1KhNYEsdDmN',
      coin: MAIN_COIN
    }],
    statuses: new Map([[TX_ID, {
      planned_out_txs: [{
        chain: 'TRON',
        to_address: 'TLe4fXH3X6yBeM13xKuhkiZ1KhNYEsdDmN',
        coin: MAIN_COIN,
        refund: false
      }],
      out_txs: [],
      stages: {
        inbound_finalised: { completed: true },
        outbound_signed: {
          scheduled_outbound_height: 9000,
          blocks_since_scheduled: 1000,
          completed: false
        }
      }
    }]]),
    mimir: { OBSERVATIONDELAYFLEXIBILITY: 20 },
    constants: {
      int_64_values: {
        SigningTransactionPeriod: 300,
        ObservationDelayFlexibility: 10,
        StreamingSwapPause: 0
      }
    },
    lastBlocks: [{ chain: 'THOR', thorchain: 10000 }],
    inboundAddresses: [{ chain: 'TRON', halted: false }],
    ...overrides
  };
}

test('classifies an overdue unpaid outbound using the original scheduled height', () => {
  const result = classifyStuckTransactions(baseInput());

  assert.equal(result.signingGraceBlocks, 320);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].tx_id, TX_ID);
  assert.equal(result.transactions[0].overdue_blocks, 1000);
  assert.equal(result.transactions[0].amount, MAIN_COIN.amount);
});

test('keeps an unpaid obligation when sibling outbounds completed', () => {
  const input = baseInput();
  const status = input.statuses.get(TX_ID);
  status.planned_out_txs.unshift({
    chain: 'TRON',
    to_address: 'TLe4fXH3X6yBeM13xKuhkiZ1KhNYEsdDmN',
    coin: { ...MAIN_COIN, amount: '2500000' },
    refund: false
  });
  status.out_txs.push({
    chain: 'TRON',
    to_address: 'TLe4fXH3X6yBeM13xKuhkiZ1KhNYEsdDmN',
    coins: [{ ...MAIN_COIN, amount: '2500000' }]
  });

  const result = classifyStuckTransactions(input);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].completed_outbounds, 1);
  assert.equal(result.transactions[0].amount, MAIN_COIN.amount);
});

test('does not classify paid, within-window, or signing-halted outbounds', () => {
  const paidInput = baseInput();
  paidInput.statuses.get(TX_ID).out_txs = [{
    chain: 'TRON',
    to_address: 'TLe4fXH3X6yBeM13xKuhkiZ1KhNYEsdDmN',
    coins: [MAIN_COIN]
  }];
  assert.equal(classifyStuckTransactions(paidInput).transactions.length, 0);

  const recentInput = baseInput();
  recentInput.statuses.get(TX_ID).stages.outbound_signed.blocks_since_scheduled = 319;
  assert.equal(classifyStuckTransactions(recentInput).transactions.length, 0);

  const haltedInput = baseInput({ mimir: { HALTSIGNINGTRON: 1 } });
  assert.equal(classifyStuckTransactions(haltedInput).transactions.length, 0);
});

test('classifies only streaming swaps that stopped beyond their progress window', () => {
  const input = baseInput({
    outboundQueue: [],
    statuses: new Map(),
    streamingSwaps: [
      {
        tx_id: 'STALLED',
        source_asset: 'ETH.ETH',
        target_asset: 'BCH.BCH',
        destination: 'bitcoincash:qtest',
        interval: 100,
        quantity: 10,
        count: 4,
        last_height: 9600,
        trade_target: '500000000'
      },
      {
        tx_id: 'PROGRESSING',
        source_asset: 'ETH.ETH',
        target_asset: 'BCH.BCH',
        interval: 100,
        quantity: 10,
        count: 4,
        last_height: 9800
      }
    ],
    inboundAddresses: [
      { chain: 'ETH', halted: false },
      { chain: 'BCH', halted: false }
    ]
  });

  const result = classifyStuckTransactions(input);
  assert.deepEqual(result.transactions.map((row) => row.tx_id), ['STALLED']);
  assert.equal(result.transactions[0].stage, 'streaming_swap');
});

test('excludes active limit orders and currently halted streaming swaps', () => {
  const streaming = {
    tx_id: 'LIMIT',
    source_asset: 'ETH.ETH',
    target_asset: 'BCH.BCH',
    interval: 100,
    quantity: 10,
    count: 1,
    last_height: 9000
  };
  const limitInput = baseInput({
    outboundQueue: [],
    statuses: new Map(),
    swapQueue: [{ tx: { id: 'LIMIT' }, swap_type: 'limit' }],
    streamingSwaps: [streaming]
  });
  assert.equal(classifyStuckTransactions(limitInput).transactions.length, 0);

  const pausedInput = baseInput({
    outboundQueue: [],
    statuses: new Map(),
    streamingSwaps: [{ ...streaming, tx_id: 'PAUSED' }],
    mimir: { STREAMINGSWAPPAUSE: 1 }
  });
  assert.equal(classifyStuckTransactions(pausedInput).transactions.length, 0);
});
