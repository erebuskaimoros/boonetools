import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { config } from '../src/lib/config.js';
import {
  buildWasmArbOracleTrackingRows,
  deriveFinExecutionPriceUsd,
  ingestOracleTracking,
  isUnsupportedPoolPriceError,
  normalizeCollectorBlockSearchCandidates,
  normalizeCollectorTxSearchCandidates,
  normalizeCollectorTransferCandidates,
  normalizeWasmArbAction,
  normalizeWasmArbNetworkBucket,
  parseWasmArbRujiraFeeEvents,
  priceRujiraFeeEvents,
  RUJIRA_TRADE_COLLECTOR,
  scanCandidateBlocks,
  scanCollectorSearchPages,
  wasmRuntimeOptions,
  WASM_ARB_CONTRACT
} from '../src/shared/wasm-arb-economics-ingestion.js';

const FIN = 'thor1fincontract000000000000000000000000000000000000000000000000000000';

test('Wasm monitoring ingestion starts at the Mimir-zero activation', () => {
  assert.equal(config.wasmArbEconomicsStartTime, '2026-07-27T14:04:45Z');
  assert.equal(config.wasmArbEconomicsStartHeight, 27181679);
  assert.equal(config.wasmArbEconomicsOracleStartHeight, 27181679);
  assert.equal(config.wasmArbEconomicsOracleGapRetryAttempts, 3);
  assert.equal(config.wasmArbEconomicsMissingPoolCacheMs, 24 * 60 * 60 * 1000);
});

function event(type, attributes) {
  return {
    type,
    attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: String(value) }))
  };
}

function eventAttributes(type, attributes) {
  return {
    type,
    attributes: attributes.map(([key, value]) => ({ key, value: String(value) }))
  };
}

test('normalizes authoritative Wasm swap actions with executed-leg volume', () => {
  const action = normalizeWasmArbAction({
    height: '27190000',
    date: '1785231600000000000',
    type: 'swap',
    status: 'success',
    in: [{
      txID: 'abc',
      address: WASM_ARB_CONTRACT,
      coins: [{ asset: 'BTC.BTC', amount: '100000000' }]
    }],
    out: [{
      txID: 'def',
      address: WASM_ARB_CONTRACT,
      coins: [{ asset: 'ETH.ETH', amount: '200000000' }]
    }],
    metadata: {
      swap: {
        inPriceUSD: '10',
        outPriceUSD: '6',
        liquidityFee: '125000000',
        swapSlip: '3'
      }
    }
  });

  assert.equal(action.leg_count, 2);
  assert.equal(action.input_volume_usd, 10);
  assert.equal(action.executed_leg_volume_usd, 22);
  assert.equal(action.liquidity_fee_rune, 1.25);
  assert.equal(action.swap_slip_bps, 3);
  assert.equal(action.tx_id, 'ABC');
  assert.match(action.action_key, /^wasm-arb-action:v2:/);
});

test('collapses identical duplicate outbound records before executed-leg valuation', () => {
  const outbound = {
    txID: 'def',
    address: WASM_ARB_CONTRACT,
    coins: [{ asset: 'ETH.ETH', amount: '200000000' }]
  };
  const action = normalizeWasmArbAction({
    height: '27190000',
    date: '1785231600000000000',
    type: 'swap',
    status: 'success',
    in: [{
      txID: 'abc',
      address: WASM_ARB_CONTRACT,
      coins: [{ asset: 'BTC.BTC', amount: '100000000' }]
    }],
    out: [outbound, structuredClone(outbound)],
    metadata: { swap: { inPriceUSD: '10', outPriceUSD: '6' } }
  });

  assert.equal(action.executed_leg_volume_usd, 22);
});

test('network buckets convert Midgard USD cents and base RUNE exactly once', () => {
  const row = normalizeWasmArbNetworkBucket({
    startTime: '1785231600',
    endTime: '1785231900',
    totalVolumeUSD: '123456',
    totalFees: '250000000',
    totalCount: '42',
    runePriceUSD: '4'
  });

  assert.equal(row.network_volume_usd, 1234.56);
  assert.equal(row.network_liquidity_fee_rune, 2.5);
  assert.equal(row.network_liquidity_fee_usd, 10);
  assert.equal(row.network_swap_leg_count, 42);
});

test('fee parser includes all FIN transfers, treats range as a subset, and links by tx context', () => {
  const rows = parseWasmArbRujiraFeeEvents({
    height: 27190000,
    blockTime: '2026-07-28T09:40:00Z',
    origin: 'tx_0',
    events: [
      event('wasm-rujira-thorchain-swap/swap', {
        _contract_address: WASM_ARB_CONTRACT,
        amm_fee: '25rune'
      }),
      event('wasm-rujira-fin/range.fee', {
        _contract_address: FIN,
        base: '30',
        quote: '0'
      }),
      event('transfer', {
        sender: FIN,
        recipient: RUJIRA_TRADE_COLLECTOR,
        amount: '30rune'
      }),
      event('transfer', {
        sender: FIN,
        recipient: RUJIRA_TRADE_COLLECTOR,
        amount: '70rune'
      }),
      event('transfer', {
        sender: WASM_ARB_CONTRACT,
        recipient: RUJIRA_TRADE_COLLECTOR,
        amount: '25rune'
      })
    ],
    finContracts: [FIN]
  });

  assert.deepEqual(rows.map((row) => row.fee_kind), ['fin_range', 'fin', 'amm']);
  assert.ok(rows.every((row) => row.event_key.startsWith('wasm-arb-rujira-fee:v2:')));
  assert.ok(rows.every((row) => row.wasm_linked));
  assert.equal(rows.reduce((sum, row) => sum + Number(row.amount_base), 0), 125);
});

test('fee parser retains a same-context FIN execution rate for unsupported denoms', () => {
  const [row] = parseWasmArbRujiraFeeEvents({
    height: 27190000,
    blockTime: '2026-07-28T09:40:00Z',
    origin: 'tx_0',
    events: [
      event('wasm-rujira-fin/trade', {
        _contract_address: FIN,
        side: 'quote',
        offer: '200000000',
        bid: '100000000'
      }),
      event('transfer', {
        sender: FIN,
        recipient: RUJIRA_TRADE_COLLECTOR,
        amount: '10000000x/brune'
      })
    ],
    finContracts: [{ address: FIN, denoms: ['x/brune', 'rune'] }]
  });

  assert.deepEqual(row.raw_event.finExecutionPrice, {
    baseDenom: 'x/brune',
    quoteDenom: 'rune',
    quotePerBase: 0.5
  });
  assert.deepEqual(deriveFinExecutionPriceUsd({
    denom: 'x/brune',
    hint: row.raw_event.finExecutionPrice,
    quotePriceUsd: 0.4
  }), {
    priceUsd: 0.2,
    counterDenom: 'rune'
  });
});

test('fee parser does not count arbitrary senders or unrelated recipients', () => {
  const rows = parseWasmArbRujiraFeeEvents({
    height: 27190000,
    blockTime: '2026-07-28T09:40:00Z',
    origin: 'tx_0',
    events: [
      event('transfer', {
        sender: 'thor1someoneelse',
        recipient: RUJIRA_TRADE_COLLECTOR,
        amount: '10rune'
      }),
      event('transfer', {
        sender: FIN,
        recipient: 'thor1notcollector',
        amount: '10rune'
      })
    ],
    finContracts: [FIN]
  });

  assert.deepEqual(rows, []);
});

test('finalize-block FIN fees are broad only without transaction-local linkage', () => {
  const rows = parseWasmArbRujiraFeeEvents({
    height: 27190000,
    blockTime: '2026-07-28T09:40:00Z',
    origin: 'finalize_block',
    events: [
      event('wasm-rujira-thorchain-swap/swap', {
        _contract_address: WASM_ARB_CONTRACT
      }),
      event('transfer', {
        sender: FIN,
        recipient: RUJIRA_TRADE_COLLECTOR,
        amount: '10rune'
      }),
      event('transfer', {
        sender: WASM_ARB_CONTRACT,
        recipient: RUJIRA_TRADE_COLLECTOR,
        amount: '5rune'
      })
    ],
    finContracts: [FIN]
  });

  assert.deepEqual(rows.map((row) => row.wasm_linked), [false, true]);
});

test('fee parser preserves every indexed transfer when one event contains parallel attributes', () => {
  const rows = parseWasmArbRujiraFeeEvents({
    height: 27190001,
    blockTime: '2026-07-28T09:41:00Z',
    origin: 'tx_1',
    events: [
      eventAttributes('transfer', [
        ['recipient', 'thor1unrelated'],
        ['sender', FIN],
        ['amount', '11rune'],
        ['recipient', RUJIRA_TRADE_COLLECTOR],
        ['sender', FIN],
        ['amount', '22rune'],
        ['recipient', RUJIRA_TRADE_COLLECTOR],
        ['sender', WASM_ARB_CONTRACT],
        ['amount', '33rune']
      ])
    ],
    finContracts: [FIN]
  });

  assert.deepEqual(rows.map((row) => row.amount_base), ['22', '33']);
  assert.deepEqual(rows.map((row) => row.fee_kind), ['fin', 'amm']);
});

test('collector transaction discovery filters failed, old, and unrelated indexed responses', () => {
  const transfer = (recipient) => event('transfer', {
    sender: FIN,
    recipient,
    amount: '10rune'
  });
  const responses = [
    {
      height: '27190010',
      code: 0,
      timestamp: '2026-07-28T09:42:00Z',
      events: [transfer(RUJIRA_TRADE_COLLECTOR)]
    },
    {
      height: '27190011',
      code: 4,
      timestamp: '2026-07-28T09:42:06Z',
      events: [transfer(RUJIRA_TRADE_COLLECTOR)]
    },
    {
      height: '27180000',
      code: 0,
      timestamp: '2026-07-27T09:42:00Z',
      events: [transfer(RUJIRA_TRADE_COLLECTOR)]
    },
    {
      height: '27190012',
      code: 0,
      timestamp: '2026-07-28T09:42:12Z',
      events: [transfer('thor1unrelated')]
    }
  ];

  assert.deepEqual(normalizeCollectorTransferCandidates(
    responses,
    RUJIRA_TRADE_COLLECTOR,
    27185000
  ), [{
    height: 27190010,
    blockTime: '2026-07-28T09:42:00.000Z',
    source: 'trade-collector-tx'
  }]);
});

test('Tendermint tx and block search candidates preserve both discovery lanes', () => {
  assert.deepEqual(normalizeCollectorTxSearchCandidates([{
    height: '27190010',
    tx_result: { code: 0 }
  }, {
    height: '27190011',
    tx_result: { code: 4 }
  }], 27190000), [{
    height: 27190010,
    blockTime: null,
    source: 'trade-collector-tx-search'
  }]);

  assert.deepEqual(normalizeCollectorBlockSearchCandidates([{
    block: { header: { height: '27190012', time: '2026-07-28T09:42:12Z' } }
  }], 27190000), [{
    height: 27190012,
    blockTime: '2026-07-28T09:42:12.000Z',
    source: 'trade-collector-block-search'
  }]);
});

test('collector search persists its failed page for a later timer run', async () => {
  const writes = [];
  const attemptedPages = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('from wasm_arb_economics_sync_state')) {
        return {
          rows: [{
            sync_key: 'collector-tx-search-backfill',
            cursor_value: '27260000',
            next_page_token: '3',
            complete: false,
            stats_json: { max_height: 27260000, target_height: 27262600 }
          }]
        };
      }
      if (sql.includes('insert into wasm_arb_economics_sync_state')) {
        writes.push(params);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await scanCollectorSearchPages(client, {
    syncKey: 'collector-tx-search-backfill',
    maxPages: 12,
    backfill: true,
    kind: 'tx',
    latestHeight: 27262600,
    async fetchCollectorTxSearchPage(params) {
      attemptedPages.push(params.page);
      throw new Error('provider deadline');
    }
  });

  assert.deepEqual(attemptedPages, [3]);
  assert.equal(result.pages, 0);
  assert.deepEqual(result.errors, ['provider deadline']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2], '3');
  assert.deepEqual(writes[0][4].errors, ['provider deadline']);
});

test('collector search uses a fee-discovery-specific RPC cooldown lane', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      if (sql.includes('from wasm_arb_economics_sync_state')) return { rows: [] };
      if (sql.includes('insert into wasm_arb_economics_sync_state')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await scanCollectorSearchPages(client, {
    syncKey: 'collector-tx-search-backfill',
    maxPages: 1,
    backfill: true,
    kind: 'tx',
    latestHeight: 27262600,
    async fetchRpc(path, params, options) {
      calls.push({ path, params, options });
      return { result: { txs: [], total_count: '0' } };
    }
  });

  assert.equal(result.complete, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cooldownScope, 'wasm-fee-discovery');
  assert.equal(calls[0].params.startHeight, undefined);
  assert.match(calls[0].params.query, /27181679/);
});

test('candidate block scanning defers when FIN discovery is unavailable', async () => {
  const result = await scanCandidateBlocks({
    async query() {
      throw new Error('block rows must not load before FIN metadata');
    }
  }, {
    async fetchThorchain() {
      throw new Error('THORNode unavailable');
    }
  });

  assert.equal(result.deferred, true);
  assert.equal(result.blocks, 0);
  assert.equal(result.error, 'THORNode unavailable');
});

test('candidate block scanning enforces the activation boundary and isolated RPC lane', async () => {
  const queries = [];
  const rpcCalls = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('from wasm_arb_economics_blocks')) {
        return {
          rows: [{
            height: 27181680,
            block_time: '2026-07-27T14:04:51Z',
            attempts: 0
          }]
        };
      }
      if (sql.includes('update wasm_arb_economics_blocks')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await scanCandidateBlocks(client, {
    async fetchThorchain() {
      return { contracts: [] };
    },
    async fetchRpc(path, params, options) {
      rpcCalls.push({ path, params, options });
      return { result: { txs_results: [] } };
    }
  });

  const selection = queries.find(({ sql }) => sql.includes('from wasm_arb_economics_blocks'));
  assert.equal(selection.params[2], 27181679);
  assert.match(selection.sql, /height >= \$3/);
  assert.equal(rpcCalls[0].options.cooldownScope, 'wasm-fee-blocks');
  assert.equal(result.blocks, 1);
  assert.equal(result.failures, 0);
});

test('candidate block scanning stops without poisoning the batch on an open breaker', async () => {
  const updates = [];
  let rpcCalls = 0;
  const client = {
    async query(sql, params = []) {
      if (sql.includes('from wasm_arb_economics_blocks')) {
        return {
          rows: [{
            height: 27181680,
            block_time: '2026-07-27T14:04:51Z',
            attempts: 0
          }, {
            height: 27181681,
            block_time: '2026-07-27T14:04:57Z',
            attempts: 0
          }]
        };
      }
      if (sql.includes('update wasm_arb_economics_blocks')) {
        updates.push(params);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await scanCandidateBlocks(client, {
    async fetchThorchain() {
      return { contracts: [] };
    },
    async fetchRpc() {
      rpcCalls += 1;
      if (rpcCalls === 1) throw new Error('provider timeout');
      throw Object.assign(new Error('provider cooling down'), { skipProvider: true });
    }
  });

  assert.equal(rpcCalls, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 27181680);
  assert.equal(result.blocks, 1);
  assert.equal(result.failures, 1);
});

test('Wasm lanes isolate THORNode head cooldown scopes', async () => {
  const calls = [];
  const client = { query() {} };
  const runtime = await wasmRuntimeOptions(client, {
    async fetchThorchain(path, options) {
      calls.push({ path, options });
      return [{ thorchain: '27276380' }];
    }
  }, 'oracle');

  assert.equal(runtime.latestHeight, 27276380);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/thorchain/lastblock');
  assert.equal(calls[0].options.cooldownClient, client);
  assert.equal(calls[0].options.sharedCooldown, true);
  assert.equal(calls[0].options.cooldownScope, 'wasm-oracle-head');
});

function oracleStateClient(state) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (sql.includes('from wasm_arb_economics_sync_state')) return { rows: [state] };
      if (sql.includes('insert into wasm_arb_economics_sync_state')) {
        writes.push(params);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('wasm_arb_economics_oracle_samples')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('Oracle ingestion retries an empty same-height Oracle response without advancing', async () => {
  const height = config.wasmArbEconomicsOracleStartHeight;
  const client = oracleStateClient({
    sync_key: 'oracle:backfill',
    cursor_value: String(height - config.wasmArbEconomicsOracleStrideBlocks),
    complete: false,
    stats_json: { errors: [`${height}: No comparable pool/oracle rows at height ${height}`] }
  });
  const cleared = [];
  const result = await ingestOracleTracking(client, {
    latestHeight: height,
    async fetchOracleTrackingSample() {
      return {
        height,
        blockTime: '2026-08-03T12:00:00Z',
        pools: [{ asset: 'BTC.BTC', status: 'Available' }],
        oraclePrices: []
      };
    },
    async clearOracleGapSnapshot(target) {
      cleared.push(target);
    }
  });

  assert.equal(result.cursor, height - config.wasmArbEconomicsOracleStrideBlocks);
  assert.equal(result.complete, false);
  assert.deepEqual(cleared, [height]);
  assert.equal(client.writes[0][4].gap_attempts[String(height)], 2);
  assert.deepEqual(client.writes[0][4].gaps, []);
});

test('Oracle ingestion records and skips only a confirmed empty-Oracle height', async () => {
  const height = config.wasmArbEconomicsOracleStartHeight;
  const client = oracleStateClient({
    sync_key: 'oracle:backfill',
    cursor_value: String(height - config.wasmArbEconomicsOracleStrideBlocks),
    complete: false,
    stats_json: { gap_attempts: { [String(height)]: 2 } }
  });
  const result = await ingestOracleTracking(client, {
    latestHeight: height + 1,
    async fetchOracleTrackingSample(targetHeight) {
      if (targetHeight === height + 1) {
        return {
          height: targetHeight,
          blockTime: '2026-08-03T12:00:06Z',
          pools: [{
            asset: 'BTC.BTC',
            status: 'Available',
            balance_rune: '10000000000',
            balance_asset: '100000000'
          }],
          oraclePrices: [
            { symbol: 'RUNE', price: '2' },
            { symbol: 'BTC', price: '200' }
          ]
        };
      }
      return {
        height,
        blockTime: '2026-08-03T12:00:00Z',
        pools: [{ asset: 'BTC.BTC', status: 'Available' }],
        oraclePrices: []
      };
    }
  });

  assert.equal(result.cursor, height);
  assert.equal(result.complete, true);
  assert.equal(result.gapCount, 1);
  assert.equal(result.headObservations, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(client.writes[0][4].gaps[0], {
    height,
    block_time: '2026-08-03T12:00:00Z',
    reason: 'empty-oracle-prices',
    attempts: 3,
    confirmed_at: client.writes[0][4].gaps[0].confirmed_at
  });
});

test('fee pricing negative-caches deterministic missing Midgard pools', async () => {
  const cached = [];
  const client = {
    async query(sql) {
      if (sql.includes('from wasm_arb_economics_rujira_fees')) {
        return { rows: [{
          event_key: 'wasm-arb-rujira-fee:v2:test',
          height: 27270000,
          block_time: '2026-08-03T12:00:00Z',
          denom: 'x/brune',
          amount: 1,
          raw_event: {}
        }] };
      }
      if (sql.includes('from wasm_arb_economics_network_buckets')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const error = Object.assign(new Error('400 Bad Request /history/depths/THOR.BRUNE'), {
    status: 400
  });
  const result = await priceRujiraFeeEvents(client, {
    async loadAcquisition() { return null; },
    async isMissingPoolPriceCached() {
      return false;
    },
    async fetchMidgard(path) {
      if (path === '/health') return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: 1 } };
      throw error;
    },
    async cacheMissingPoolPrice(poolAsset, receivedError) {
      cached.push({ poolAsset, receivedError });
    }
  });

  assert.equal(isUnsupportedPoolPriceError(error), true);
  assert.deepEqual(result.unsupportedDenoms, ['x/brune']);
  assert.deepEqual(result.errors, []);
  assert.equal(result.unpriced, 1);
  assert.equal(cached[0].poolAsset, 'THOR.BRUNE');
  assert.equal(cached[0].receivedError, error);
});

test('post-change migration removes legacy work and resets range-relative tx pagination', async () => {
  const migration = await readFile(
    new URL('../migrations/040_wasm_post_change_boundary.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /wasm_arb_economics_blocks\s+where height < 27181679/i);
  assert.match(migration, /wasm_arb_economics_rujira_fees\s+where height < 27181679/i);
  assert.match(migration, /wasm_arb_economics_actions\s+where height < 27181679/i);
  assert.match(migration, /wasm_arb_economics_oracle_samples\s+where height < 27181679/i);
  assert.match(migration, /sync_key = 'collector-tx-search-backfill'/i);
  assert.doesNotMatch(migration, /thorchain_market_snapshots/i);
});

test('builds same-height pool and oracle tracking rows on the report price basis', () => {
  const [row] = buildWasmArbOracleTrackingRows({
    height: 27190012,
    blockTime: '2026-07-28T09:42:12Z',
    pools: [{
      asset: 'BTC.BTC',
      status: 'Available',
      balance_rune: '10000000000',
      balance_asset: '100000000'
    }],
    oraclePrices: [
      { symbol: 'RUNE', price: '2' },
      { symbol: 'BTC', price: '205' }
    ]
  });

  assert.equal(row.pool_price_usd, 200);
  assert.equal(row.oracle_price_usd, 205);
  assert.equal(Number(row.signed_deviation_bps.toFixed(6)), -243.902439);
  assert.equal(Number(row.rune_depth_usd.toFixed(2)), 200);
});
