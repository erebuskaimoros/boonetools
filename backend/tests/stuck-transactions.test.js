import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStuckTransactionSnapshot,
  classifyStuckTransactions,
  fetchSwapQueue
} from '../src/shared/stuck-transactions.js';

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

test('does not classify paid or within-window outbounds', () => {
  const paidInput = baseInput();
  paidInput.statuses.get(TX_ID).out_txs = [{
    chain: 'TRON',
    to_address: 'TLe4fXH3X6yBeM13xKuhkiZ1KhNYEsdDmN',
    coins: [MAIN_COIN]
  }];
  assert.equal(classifyStuckTransactions(paidInput).transactions.length, 0);

  const recentInput = baseInput();
  recentInput.statuses.get(TX_ID).stages.outbound_signed.scheduled_outbound_height = 9681;
  assert.equal(classifyStuckTransactions(recentInput).transactions.length, 0);

});

test('returns overdue signing-halted outbounds separately from actionable stuck transactions', () => {
  const result = classifyStuckTransactions(baseInput({
    mimir: { HALTSIGNINGTRON: 1 }
  }));

  assert.equal(result.transactions.length, 0);
  assert.equal(result.haltedTransactions.length, 1);
  assert.equal(result.haltedTransactions[0].tx_id, TX_ID);
  assert.equal(result.haltedTransactions[0].overdue_blocks, 1000);
  assert.equal(result.haltedTransactions[0].exclusion_reason, 'active_signing_halt');
});

test('snapshot keeps halted backlog outside its actionable transaction count', async () => {
  const input = baseInput({ mimir: { HALTSIGNINGTRON: 1 } });
  const fetcher = async (endpoint) => {
    if (endpoint === '/thorchain/queue/outbound') return input.outboundQueue;
    if (endpoint === '/thorchain/queue/scheduled') return [];
    if (endpoint.startsWith('/thorchain/queue/swap/paginated')) return { swap_queue: [] };
    if (endpoint === '/thorchain/swaps/streaming') return [];
    if (endpoint.startsWith('/thorchain/tx/status/')) return input.statuses.get(TX_ID);
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const snapshot = await buildStuckTransactionSnapshot(fetcher, {
    coreSnapshot: {
      lastblock: input.lastBlocks,
      mimir: input.mimir,
      constants: input.constants,
      inbound_addresses: input.inboundAddresses,
      stale: false
    }
  });

  assert.equal(snapshot.count, 0);
  assert.deepEqual(snapshot.transactions, []);
  assert.equal(snapshot.halted_count, 1);
  assert.equal(snapshot.halted_transactions[0].tx_id, TX_ID);
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

test('stuck transaction scans reuse unchanged per-hash lookups across scheduler processes', async () => {
  const lookupRows = new Map();
  const client = {
    async query(sql, params = []) {
      if (sql.includes('select tx_id, queue_fingerprint')) {
        const lookupType = params[0];
        const hashes = params[1];
        return {
          rows: hashes.flatMap((hash) => {
            const row = lookupRows.get(`${lookupType}:${hash}`);
            return row ? [row] : [];
          })
        };
      }
      if (sql.includes('jsonb_to_recordset')) {
        for (const row of JSON.parse(params[0])) {
          lookupRows.set(`${row.lookup_type}:${row.tx_id}`, row);
        }
      }
      return { rows: [] };
    }
  };
  let statusCalls = 0;
  const fetcher = async (path) => {
    if (path === '/thorchain/queue/outbound') return baseInput().outboundQueue;
    if (path === '/thorchain/queue/scheduled') return [];
    if (path.startsWith('/thorchain/queue/swap/paginated')) return { swap_queue: [] };
    if (path === '/thorchain/swaps/streaming') return [];
    if (path.startsWith('/thorchain/tx/status/')) {
      statusCalls += 1;
      return baseInput().statuses.get(TX_ID);
    }
    throw new Error(`Unexpected endpoint ${path}`);
  };
  const coreSnapshot = {
    lastblock: baseInput().lastBlocks,
    mimir: baseInput().mimir,
    constants: baseInput().constants,
    inbound_addresses: baseInput().inboundAddresses,
    stale: false
  };

  const first = await buildStuckTransactionSnapshot(fetcher, { client, coreSnapshot });
  coreSnapshot.lastblock = [{ chain: 'THOR', thorchain: 10001 }];
  const second = await buildStuckTransactionSnapshot(fetcher, { client, coreSnapshot });
  assert.equal(first.lookups.fetched, 1);
  assert.equal(second.lookups.fetched, 0);
  assert.equal(second.lookups.reused, 1);
  assert.equal(statusCalls, 1);
  assert.equal(second.transactions.length, 1);
  assert.equal(second.transactions[0].overdue_blocks, 1001);
});


test('swap queue scanning uses bounded pages and includes transactions after the first page', async () => {
  const input = baseInput();
  const offsets = [];
  const inspected = [];
  const fetcher = async (endpoint) => {
    if (endpoint.startsWith('/thorchain/queue/swap/paginated')) {
      const url = new URL(endpoint, 'https://example.test');
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      assert.ok(limit <= 100, 'queue pages must stay below the observed gRPC payload limit');
      offsets.push(offset);
      if (offset === 0) return { swap_queue: Array.from({ length: limit }, (_, i) => ({ tx: { id: `LIMIT-${i}` }, swap_type: 'limit' })), pagination: { offset, limit, total: limit + 1, has_next: true } };
      return { swap_queue: [{ tx: { id: TX_ID }, swap_type: 'market' }], pagination: { offset, limit, total: offset + 1, has_next: false } };
    }
    if (endpoint === '/thorchain/queue/outbound' || endpoint === '/thorchain/queue/scheduled' || endpoint === '/thorchain/swaps/streaming') return [];
    if (endpoint.startsWith('/thorchain/tx/status/')) { inspected.push(endpoint); return input.statuses.get(TX_ID); }
    if (endpoint.startsWith('/thorchain/tx/details/')) return {};
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  await buildStuckTransactionSnapshot(fetcher, { coreSnapshot: { lastblock: input.lastBlocks, mimir: input.mimir, constants: input.constants, inbound_addresses: input.inboundAddresses, stale: false } });
  assert.ok(offsets.length >= 2);
  assert.ok(inspected.some(endpoint => endpoint.endsWith(TX_ID)), 'later-page market swap must be inspected');
});

function swapQueuePage(endpoint, rows, total) {
  const url = new URL(endpoint, 'https://example.test');
  const offset = Number(url.searchParams.get('offset'));
  const limit = Number(url.searchParams.get('limit'));
  return { swap_queue: rows, pagination: { offset, limit, total, has_next: offset + rows.length < total } };
}

test('swap queue retries oversized pages at the same offset with a smaller limit', async () => {
  const calls = [];
  const oversized = Object.assign(new Error('Request failed (429)'), {
    status: 429,
    body: '{"code":8,"message":"grpc: received message larger than max (18456216 vs. 10485760)"}'
  });
  const rows = Array.from({ length: 75 }, (_, i) => ({ tx: { id: `SWAP-${i}` } }));
  const result = await fetchSwapQueue(async (endpoint, options) => {
    const url = new URL(endpoint, 'https://example.test');
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    calls.push([offset, limit]);
    assert.equal(options.shouldStop(oversized), true);
    if (limit > 50) throw oversized;
    return swapQueuePage(endpoint, rows.slice(offset, offset + limit), rows.length);
  });
  assert.deepEqual(calls, [[0, 100], [0, 50], [50, 50]]);
  assert.deepEqual(result, rows);
});

test('swap queue deduplicates entries repeated across pages', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ tx: { id: `SWAP-${i}` } }));
  const result = await fetchSwapQueue(async (endpoint) => {
    const offset = Number(new URL(endpoint, 'https://example.test').searchParams.get('offset'));
    return swapQueuePage(endpoint, offset === 0 ? first : [first[99], { tx: { id: 'LAST' } }], 102);
  });
  assert.equal(result.length, 101);
  assert.equal(result.at(-1).tx.id, 'LAST');
});

test('swap queue fails the whole scan when a later page fails', async () => {
  const failure = new Error('second page unavailable');
  await assert.rejects(fetchSwapQueue(async (endpoint) => {
    const offset = Number(new URL(endpoint, 'https://example.test').searchParams.get('offset'));
    if (offset > 0) throw failure;
    return swapQueuePage(endpoint, Array.from({ length: 100 }, (_, i) => ({ tx: { id: `SWAP-${i}` } })), 101);
  }), failure);
});

test('swap queue respects genuine throttling instead of shrinking and retrying', async () => {
  for (const error of [
    Object.assign(new Error('Too many requests'), { status: 429 }),
    Object.assign(new Error('grpc: received message larger than max'), { status: 429, retryAfterSeconds: 60 })
  ]) {
    let calls = 0;
    await assert.rejects(fetchSwapQueue(async (endpoint, options) => {
      calls += 1;
      assert.equal(options.shouldStop(error), false);
      throw error;
    }), error);
    assert.equal(calls, 1);
  }
});

test('swap queue stops shrinking when one entry still exceeds the payload limit', async () => {
  const error = Object.assign(new Error('Payload too large'), { status: 413 });
  const limits = [];
  await assert.rejects(fetchSwapQueue(async (endpoint) => {
    limits.push(Number(new URL(endpoint, 'https://example.test').searchParams.get('limit')));
    throw error;
  }), error);
  assert.deepEqual(limits, [100, 50, 25, 12, 6, 3, 1]);
});

test('swap queue rejects invalid or truncated pagination', async () => {
  for (const payload of [
    {},
    { swap_queue: [{ tx: { id: 'FIRST' } }] },
    { swap_queue: [], pagination: { offset: 0, limit: 100, total: 10, has_next: true } },
    { swap_queue: [{ tx: { id: 'FIRST' } }], pagination: { offset: 0, limit: 100, total: 101, has_next: false } },
    { swap_queue: [], pagination: { offset: 100, limit: 100, total: 0, has_next: false } }
  ]) {
    await assert.rejects(fetchSwapQueue(async () => payload), /Invalid swap queue/);
  }
});

test('swap queue rejects a provider that repeats a page without making progress', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ tx: { id: `SWAP-${i}` } }));
  await assert.rejects(fetchSwapQueue(async (endpoint) => swapQueuePage(endpoint, rows, 1000)), /made no progress/);
});

test('swap queue bounds scanning and fails rather than publishing a truncated queue', async () => {
  let calls = 0;
  await assert.rejects(fetchSwapQueue(async (endpoint) => {
    calls += 1;
    const offset = Number(new URL(endpoint, 'https://example.test').searchParams.get('offset'));
    return swapQueuePage(endpoint, Array.from({ length: 100 }, (_, i) => ({ tx: { id: `SWAP-${offset + i}` } })), 1_000_000);
  }), /exceeded 200 pages/);
  assert.equal(calls, 200);
});
