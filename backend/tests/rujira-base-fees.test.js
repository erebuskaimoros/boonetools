import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RUJIRA_VS_CONTRACTS } from '../../shared/rujira-contracts.js';

function event(type, attrs) {
  return {
    type,
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: String(value)
    }))
  };
}

test('Rujira single and batch RPC requests fail over to NativeSwap on rate limits', async (t) => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { fetchRujiraBaseFeeRpcBlockResults, fetchRujiraBaseFeeRpcBlockResultsBatch } = await import('../src/shared/rujira-base-fees.js');
  const primary = 'https://gateway.liquify.com/chain/thorchain_rpc';
  const fallback = 'https://public-thorchain-rpc.nativeswap.io';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    if (url.endsWith('/status')) return Response.json({ result: {
      node_info: { network: 'thorchain-1' }, sync_info: { earliest_block_height: '27984001',
        latest_block_height: '28280000', latest_block_time: new Date().toISOString(), catching_up: false }
    } });
    return url.startsWith(primary) ? new Response('rate limited', { status: 429 })
      : Response.json({ jsonrpc: '2.0', id: '28274900', result: { height: '28274900' } });
  });
  assert.equal((await fetchRujiraBaseFeeRpcBlockResults(28274900)).result.height, '28274900');
  const batch = await fetchRujiraBaseFeeRpcBlockResultsBatch([28274900]);
  assert.equal(batch[0].payload.result.height, '28274900');
  assert.deepEqual(calls, [`${fallback}/status`, `${primary}/block_results?height=28274900`, `${fallback}/block_results?height=28274900`, `${fallback}/`]);
});

function midgardAction(height, txId = `tx-${height}`) {
  return {
    height: String(height),
    date: '1785680000000000000',
    status: 'success',
    in: [{ txID: txId }],
    out: [],
    metadata: { swap: { memo: `=:THOR.RUNE:thor1dest:${height}` } }
  };
}

function createActionIngestClient({ syncState = null, maxHeight = 0 } = {}) {
  const queries = [];
  const savedStates = [];
  return {
    queries,
    savedStates,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('select sync_key') && sql.includes('from rujira_base_fee_sync_state')) {
        return { rows: syncState ? [syncState] : [] };
      }
      if (sql.includes('select greatest(')) {
        return { rows: [{ max_height: String(maxHeight) }] };
      }
      if (sql.includes('insert into "rujira_base_fee_sync_state"')) {
        savedStates.push({
          sync_key: params[0],
          next_page_token: params[1],
          complete: params[2],
          stats_json: JSON.parse(params[5])
        });
      }
      return { rows: [], rowCount: 1 };
    }
  };
}

test('parseRujiraBaseFeeBlock counts only memo-matched Rujira THORChain swap fees', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    RUJIRA_THORCHAIN_SWAP_CONTRACT,
    RUJI_SWAP_REVENUE_COLLECTOR,
    parseRujiraBaseFeeBlock
  } = await import('../src/shared/rujira-base-fees.js');

  const block = {
    result: {
      txs_results: [
        {
          events: [
            event('wasm-rujira-fin/trade', {
              _contract_address: 'thor1fincontract',
              offer: '100000000',
              bid: '200000000',
              side: 'quote'
            }),
            event('wasm-rujira-thorchain-swap/swap', {
              _contract_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
              amount: '100000000rune',
              memo: '=:BTC.BTC:thor1dest:0/1/1'
            })
          ]
        },
        {
          events: [
            event('wasm-rujira-revenue/run', {
              _contract_address: RUJI_SWAP_REVENUE_COLLECTOR,
              denom: 'rune'
            }),
            event('wasm-rujira-thorchain-swap/swap', {
              _contract_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
              amount: '200000000rune',
              memo: '=:ETH.ETH:thor1dest:0/1/1'
            })
          ]
        }
      ],
      finalize_block_events: [
        event('swap', {
          id: 'unrelated',
          from: 'thor1notrujira',
          to: 'thor1dest',
          pool: 'BTC.BTC',
          chain: 'THOR',
          coin: '100000000 THOR.RUNE',
          memo: '=:BTC.BTC:thor1dest:0/1/1',
          liquidity_fee_in_rune: '999'
        }),
        event('swap', {
          id: 'included',
          from: RUJIRA_THORCHAIN_SWAP_CONTRACT,
          to: 'thor1dest',
          pool: 'BTC.BTC',
          chain: 'THOR',
          coin: '100000000 THOR.RUNE',
          memo: '=:BTC.BTC:thor1dest:0/1/1',
          liquidity_fee_in_rune: '12345'
        }),
        event('swap', {
          id: 'excluded',
          from: RUJIRA_THORCHAIN_SWAP_CONTRACT,
          to: 'thor1dest',
          pool: 'ETH.ETH',
          chain: 'THOR',
          coin: '200000000 THOR.RUNE',
          memo: '=:ETH.ETH:thor1dest:0/1/1',
          liquidity_fee_in_rune: '67890'
        }),
        event('swap', {
          id: 'not-emitted-by-rujira',
          from: RUJIRA_THORCHAIN_SWAP_CONTRACT,
          to: 'thor1dest',
          pool: 'DOGE.DOGE',
          chain: 'THOR',
          coin: '300000000 THOR.RUNE',
          memo: '=:DOGE.DOGE:thor1dest:0/1/1',
          liquidity_fee_in_rune: '11111'
        })
      ]
    }
  };

  const parsed = parseRujiraBaseFeeBlock(123, block, {
    blockTime: '2026-05-18T00:00:00.000Z'
  });

  assert.equal(parsed.events.length, 2);

  const included = parsed.events.find((row) => row.swap_id === 'INCLUDED');
  assert.equal(included.included, true);
  assert.equal(included.classification, 'fin_base_layer_execution');
  assert.equal(included.liquidity_fee_rune, 0.00012345);

  const excluded = parsed.events.find((row) => row.swap_id === 'EXCLUDED');
  assert.equal(excluded.included, false);
  assert.equal(excluded.classification, 'ruji_swap_revenue_excluded');

  assert.equal(parsed.scan.final_rujira_swap_count, 3);
  assert.equal(parsed.scan.matched_event_count, 2);
  assert.equal(parsed.scan.included_event_count, 1);
  assert.equal(parsed.scan.excluded_event_count, 1);
});

test('saveParsedRujiraBaseFeeBlock skips empty websocket blocks by default', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { saveParsedRujiraBaseFeeBlock } = await import('../src/shared/rujira-base-fees.js');
  const queries = [];
  const client = {
    query: async (...args) => {
      queries.push(args);
      return { rows: [], rowCount: 0 };
    }
  };

  const parsed = await saveParsedRujiraBaseFeeBlock(client, 456, {
    result: {
      txs_results: [],
      finalize_block_events: []
    }
  }, {
    blockTime: '2026-05-18T00:00:00.000Z',
    source: 'ws'
  });

  assert.equal(parsed.events.length, 0);
  assert.equal(queries.length, 0);
});

test('JSON-RPC block batches preserve requested height order and isolate item errors', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { parseRujiraBaseFeeRpcBatchResponse } = await import('../src/shared/rujira-base-fees.js');
  const rows = parseRujiraBaseFeeRpcBatchResponse([
    { jsonrpc: '2.0', id: '102', result: { height: '102', txs_results: [] } },
    { jsonrpc: '2.0', id: '101', error: { code: -32603, message: 'height unavailable' } }
  ], [101, 102, 103]);

  assert.deepEqual(rows.map((row) => row.height), [101, 102, 103]);
  assert.match(rows[0].error.message, /height unavailable/);
  assert.equal(rows[1].payload.result.height, '102');
  assert.match(rows[2].error.message, /missing height 103/);
});

test('a one-height JSON-RPC batch accepts the server single-response shape', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { parseRujiraBaseFeeRpcBatchResponse } = await import('../src/shared/rujira-base-fees.js');
  const rows = parseRujiraBaseFeeRpcBatchResponse({
    jsonrpc: '2.0',
    id: '201',
    result: { height: '201', txs_results: [] }
  }, [201]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].height, 201);
  assert.equal(rows[0].payload.result.height, '201');
});

test('generated-fee action ingestion scans forward from a durable floor without disturbing historical backfill', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { ingestRujiraBaseFeeActionPages } = await import('../src/shared/rujira-base-fees.js');
  const client = createActionIngestClient({
    maxHeight: 300,
    syncState: {
      next_page_token: 'history-cursor',
      complete: false,
      rate_limited_until: null,
      stats_json: {}
    }
  });
  const forwardRequests = [];
  const historyRequests = [];

  const result = await ingestRujiraBaseFeeActionPages(client, {
    maxPages: 1,
    headMaxPages: 2,
    headLookbackBlocks: 200,
    requestDelayMs: 0,
    fetchForwardPage: async (request) => {
      forwardRequests.push(request);
      if (request.fromHeight === 100) {
        return {
          actions: [midgardAction(200), midgardAction(150)],
          meta: { prevPageToken: 'forward-cursor' }
        };
      }
      return { actions: [], meta: { prevPageToken: '' } };
    },
    fetchPage: async (token) => {
      historyRequests.push(token);
      return {
        actions: [midgardAction(50)],
        meta: { nextPageToken: 'history-next' }
      };
    }
  });

  assert.deepEqual(forwardRequests, [
    { fromHeight: 100 },
    { prevPageToken: 'forward-cursor' }
  ]);
  assert.deepEqual(historyRequests, ['history-cursor']);
  assert.equal(result.head_refresh.max_height, 200);
  assert.equal(result.head_catchup.floor_height, 100);
  assert.equal(result.head_catchup.watermark_height, 200);
  assert.equal(result.head_catchup.next_page_token, '');
  assert.equal(result.head_catchup.complete, true);
  assert.equal(result.next_page_token, 'history-next');
  assert.equal(result.mode, 'backfill');
  assert.equal(client.savedStates.at(-1).next_page_token, 'history-next');
  assert.equal(client.savedStates.at(-1).stats_json.head_catchup.watermark_height, 200);
});

test('generated-fee head catch-up resumes its forward cursor and advances the watermark only on completion', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { ingestRujiraBaseFeeActionPages } = await import('../src/shared/rujira-base-fees.js');
  const client = createActionIngestClient({
    maxHeight: 300,
    syncState: {
      next_page_token: 'history-cursor',
      complete: false,
      rate_limited_until: null,
      stats_json: {
        head_catchup: {
          direction: 'forward',
          next_page_token: 'saved-forward-cursor',
          floor_height: 100,
          watermark_height: 80,
          max_height: 200,
          complete: false
        }
      }
    }
  });
  const forwardRequests = [];

  const result = await ingestRujiraBaseFeeActionPages(client, {
    maxPages: 0,
    headMaxPages: 1,
    requestDelayMs: 0,
    fetchForwardPage: async (request) => {
      forwardRequests.push(request);
      return {
        actions: [midgardAction(250)],
        meta: { prevPageToken: '' }
      };
    }
  });

  assert.deepEqual(forwardRequests, [{ prevPageToken: 'saved-forward-cursor' }]);
  assert.equal(result.head_catchup.floor_height, 100);
  assert.equal(result.head_catchup.next_page_token, '');
  assert.equal(result.head_catchup.complete, true);
  assert.equal(result.head_catchup.watermark_height, 250);
  assert.equal(result.next_page_token, 'history-cursor');
  assert.equal(client.savedStates.at(-1).next_page_token, 'history-cursor');
});

test('a forward scan that finds nothing newer moves its watermark up to Midgard\'s own height', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { ingestRujiraBaseFeeActionPages } = await import('../src/shared/rujira-base-fees.js');
  const dormant = () => createActionIngestClient({
    maxHeight: 9000,
    syncState: {
      next_page_token: '', complete: true, rate_limited_until: null,
      stats_json: { head_catchup: { direction: 'forward', next_page_token: 'stale-cursor',
        floor_height: 100, watermark_height: 100, max_height: 100, complete: false } }
    }
  });
  const run = (client, options) => ingestRujiraBaseFeeActionPages(client, {
    maxPages: 0, headMaxPages: 2, requestDelayMs: 0, ...options });

  // A contract with no swaps for weeks makes Midgard scan the whole gap on
  // every run; once the gap is verified empty the next scan starts near the tip.
  const client = dormant();
  const empty = await run(client, {
    fetchForwardPage: async () => ({ actions: [], meta: { prevPageToken: '' } }),
    fetchMidgardHeight: async () => 9000
  });
  assert.equal(empty.head_catchup.complete, true);
  assert.equal(empty.head_catchup.watermark_height, 8000);
  const requests = [];
  const resumed = createActionIngestClient({ maxHeight: 9000, syncState: {
    next_page_token: '', complete: true, rate_limited_until: null, stats_json: client.savedStates.at(-1).stats_json } });
  await run(resumed, {
    fetchForwardPage: async (request) => { requests.push(request); return { actions: [], meta: { prevPageToken: '' } }; },
    fetchMidgardHeight: async () => 9000
  });
  assert.deepEqual(requests, [{ fromHeight: 8000 }]);

  // Newer actions set the watermark themselves; Midgard's height is not asked for.
  let heightReads = 0;
  const active = await run(dormant(), {
    fetchForwardPage: async () => ({ actions: [midgardAction(250)], meta: { prevPageToken: '' } }),
    fetchMidgardHeight: async () => { heightReads += 1; return 9000; }
  });
  assert.equal(active.head_catchup.watermark_height, 250);
  assert.equal(heightReads, 0);

  // Without a verified Midgard height the watermark stays where it was.
  const unknown = await run(dormant(), {
    fetchForwardPage: async () => ({ actions: [], meta: { prevPageToken: '' } }),
    fetchMidgardHeight: async () => { throw new Error('health unavailable'); }
  });
  assert.equal(unknown.head_catchup.complete, true);
  assert.equal(unknown.head_catchup.watermark_height, 100);
});

test('generated-fee first run starts historical reverse paging independently', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { ingestRujiraBaseFeeActionPages } = await import('../src/shared/rujira-base-fees.js');
  const client = createActionIngestClient();
  const requestedTokens = [];
  const pages = new Map([
    ['', { actions: [midgardAction(20)], meta: { nextPageToken: 'page-2' } }],
    ['page-2', { actions: [midgardAction(10)], meta: { nextPageToken: 'page-3' } }]
  ]);

  const result = await ingestRujiraBaseFeeActionPages(client, {
    maxPages: 2,
    headMaxPages: 0,
    requestDelayMs: 0,
    fetchPage: async (token) => {
      requestedTokens.push(token);
      return pages.get(token);
    }
  });

  assert.deepEqual(requestedTokens, ['', 'page-2']);
  assert.equal(result.pages, 2);
  assert.equal(result.backfill.pages, 2);
  assert.equal(result.backfill.reused_head_page, false);
  assert.equal(result.next_page_token, 'page-3');
});

test('generated-fee forward refresh failure preserves both cursors and does not starve later job lanes', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { ingestRujiraBaseFeeActionPages } = await import('../src/shared/rujira-base-fees.js');
  const syncState = {
    next_page_token: 'history-cursor',
    complete: false,
    rate_limited_until: null,
      stats_json: {
        head_catchup: {
          direction: 'forward',
          next_page_token: 'forward-cursor',
          floor_height: 100,
          watermark_height: 90,
          complete: false
        }
      }
  };
  const client = createActionIngestClient({ syncState, maxHeight: 200 });

  const result = await ingestRujiraBaseFeeActionPages(client, {
    maxPages: 1,
    headMaxPages: 1,
    requestDelayMs: 0,
    fetchForwardPage: async () => {
      throw new Error('head unavailable');
    },
    fetchPage: async () => {
      throw new Error('historical paging should be skipped after the head failure');
    }
  });

  assert.equal(result.head_catchup.error, 'head unavailable');
  assert.equal(result.next_page_token, 'history-cursor');
  assert.equal(client.savedStates.length, 1);
  assert.equal(client.savedStates[0].next_page_token, 'history-cursor');
  assert.equal(client.savedStates[0].stats_json.head_catchup.next_page_token, 'forward-cursor');
  assert.equal(client.savedStates[0].stats_json.head_catchup.watermark_height, 90);
});

test('generated-fee historical page failure preserves completed forward progress', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { ingestRujiraBaseFeeActionPages } = await import('../src/shared/rujira-base-fees.js');
  const client = createActionIngestClient({
    maxHeight: 300,
    syncState: {
      next_page_token: 'history-cursor',
      complete: false,
      rate_limited_until: null,
      stats_json: {
        head_catchup: {
          direction: 'forward',
          next_page_token: '',
          floor_height: 250,
          watermark_height: 250,
          max_height: 250,
          complete: true
        }
      }
    }
  });

  const result = await ingestRujiraBaseFeeActionPages(client, {
    maxPages: 1,
    headMaxPages: 1,
    requestDelayMs: 0,
    fetchForwardPage: async () => ({
      actions: [midgardAction(300)],
      meta: { prevPageToken: '' }
    }),
    fetchPage: async () => {
      throw new Error('old page timed out');
    }
  });

  assert.equal(result.head_catchup.complete, true);
  assert.equal(result.head_catchup.watermark_height, 300);
  assert.equal(result.backfill.error, 'old page timed out');
  assert.equal(result.next_page_token, 'history-cursor');
  assert.equal(client.savedStates.at(-1).stats_json.head_catchup.watermark_height, 300);
});

test('dashboard provenance reflects persisted Dune and legacy rows instead of the last sync state alone', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { getRujiraBaseFeesDashboardPayload } = await import('../src/shared/rujira-base-fees.js');
  const client = {
    query: async (sql) => {
      if (sql.includes('from rujira_base_fee_actions')) {
        return { rows: [{ count: '2', min_height: '1', max_height: '2' }] };
      }
      if (sql.includes('from rujira_base_fee_blocks')) {
        return { rows: [{ status: 'fetched', count: '2' }] };
      }
      if (sql.includes('source_providers')) {
        return {
          rows: [{
            total_events: '2',
            included_events: '2',
            excluded_events: '0',
            active_heights: '2',
            included_fee_rune: '3',
            included_fee_usd: '4',
            source_providers: ['dune', 'legacy'],
            updated_at: '2026-05-01T00:00:00.000Z'
          }]
        };
      }
      if (sql.includes('from rujira_base_fee_sync_state')) {
        return {
          rows: [{
            next_page_token: '',
            complete: true,
            rate_limited_until: null,
            updated_at: '2026-05-01T00:00:00.000Z',
            stats_json: {
              source: 'dune',
              dune_query_id: '7620091',
              dune_execution_id: 'execution-1',
              head_catchup: {
                direction: 'forward',
                complete: false,
                floor_height: 100,
                watermark_height: 90,
                min_height: 150,
                max_height: 200,
                pages: 4,
                next_page_token: 'head-next',
                error: 'temporary timeout'
              }
            }
          }]
        };
      }
      if (sql.includes("job_name = 'rujira-base-fees-ws-listener'")) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const payload = await getRujiraBaseFeesDashboardPayload(client);

  assert.equal(payload.meta.source, 'mixed-dune-and-legacy-postgres');
  assert.deepEqual(payload.meta.sourceProviders, ['dune', 'legacy']);
  assert.match(payload.meta.method, /Canonical swap identities prevent/i);
  assert.deepEqual(payload.meta.headCatchup, {
    direction: 'forward',
    complete: false,
    floorHeight: 100,
    watermarkHeight: 90,
    minHeight: 150,
    maxHeight: 200,
    pages: 4,
    nextPageToken: 'head-next',
    error: 'temporary timeout'
  });
});


for (const sample of [
  { height: 28558676, feeAtomic: 6608285, txId: '803B6D5277414548DA0CBF2C5C0DD9DD0BA2AA3317B79CD3B4A9CE9454C51D18', label: 'VS v2 swap' },
  { height: 28531109, feeAtomic: 1114027, txId: '9AA73213939DF6FDC27BADCA1B852E51D010764CFDCE8858D354E40885FBB31E', label: 'VS v2 arbitrage' }
]) {
  test(`parseRujiraBaseFeeBlock includes real ${sample.label} fees from the new deployment`, async () => {
    process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
    const { parseRujiraBaseFeeBlock } = await import('../src/shared/rujira-base-fees.js');
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/rujira-vs-v2-${sample.height}.json`, import.meta.url), 'utf8'));
    const parsed = parseRujiraBaseFeeBlock(sample.height, fixture);
    const rows = parsed.events.filter(row => row.swap_id === sample.txId);
    assert.equal(rows.length, 2, 'both executed pool legs must be tracked');
    assert.ok(rows.every(row => row.included), 'verified app-layer swaps contribute to generated fees');
    assert.equal(Math.round(rows.reduce((total, row) => total + row.liquidity_fee_rune, 0) * 1e8), sample.feeAtomic);
    assert.ok(rows.every(row => row.source_contract === 'thor18wkpr24rha007awldxx5hkyxdtnw5jamnuez9e27y6qy9u0tpkrqukal6t'), 'attribute fees to the FIN market, not an unrelated event');
  });
}

function realVsFixture(height) {
  return JSON.parse(readFileSync(new URL(`./fixtures/rujira-vs-v2-${height}.json`, import.meta.url), 'utf8'));
}

function setAttribute(row, key, value) {
  row.attributes.find(attribute => attribute.key === key).value = value;
}

function attribute(row, key) {
  return row.attributes.find(item => item.key === key)?.value;
}

test('v2 arb attribution rejects missing, cross-contract, conflicting and failed-transaction evidence', async t => {
  const { parseRujiraBaseFeeBlock } = await import('../src/shared/rujira-base-fees.js');
  const cases = {
    'missing native ID': rows => rows.filter(row => !attribute(row, 'native_tx_id')),
    'wrong native ID': rows => { setAttribute(rows.find(row => attribute(row, 'native_tx_id')), 'native_tx_id', 'A'.repeat(64)); return rows; },
    'unverified native ID emitter': rows => { setAttribute(rows.find(row => attribute(row, 'native_tx_id')), '_contract_address', RUJIRA_VS_CONTRACTS[1].address); return rows; },
    'wrong FIN market': rows => { setAttribute(rows.find(row => attribute(row, 'action') === 'arb_swap'), 'fin', 'thor1anothermarket'); return rows; },
    'wrong lot provider': rows => { setAttribute(rows.find(row => row.type === 'wasm-rujira-fin/arb_lot'), 'provider', RUJIRA_VS_CONTRACTS[1].address); return rows; },
    'offer does not match either executed leg': rows => { setAttribute(rows.find(row => row.type === 'wasm-rujira-fin/arb_lot'), 'offer', '1btc-btc'); return rows; },
    'duplicate native ID contexts': rows => [...rows.filter(row => row.type !== 'swap'), ...rows],
    'wrong final sender': rows => { rows.filter(row => row.type === 'swap').forEach(row => setAttribute(row, 'from', RUJIRA_VS_CONTRACTS[1].address)); return rows; },
    'failed transaction context': rows => rows
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const fixture = realVsFixture(28531109);
    fixture.result.finalize_block_events = mutate(fixture.result.finalize_block_events);
    if (name === 'failed transaction context') {
      const rows = fixture.result.finalize_block_events;
      fixture.result.txs_results = [{ code: 5, events: rows.filter(row => row.type !== 'swap') }];
      fixture.result.finalize_block_events = rows.filter(row => row.type === 'swap');
    }
    assert.equal(parseRujiraBaseFeeBlock(28531109, fixture).events.length, 0, name);
  });
});

test('v2 memo matching is contract-scoped and retains direct/RUJI Swap exclusions', async () => {
  const { parseRujiraBaseFeeBlock, RUJI_SWAP_REVENUE_COLLECTOR } = await import('../src/shared/rujira-base-fees.js');
  const fixture = realVsFixture(28558676);
  const swaps = fixture.result.finalize_block_events.filter(row => row.type === 'swap');
  const memo = fixture.result.txs_results.flatMap(tx => tx.events || []).find(row => row.type === 'wasm-rujira-thorchain-swap/swap');
  assert.ok(memo);
  const context = [{ code: 0, events: [memo] }];
  const direct = parseRujiraBaseFeeBlock(28558676, { result: { txs_results: context, finalize_block_events: swaps } });
  assert.equal(direct.events.length, 2);
  assert.ok(direct.events.every(row => !row.included && row.classification === 'direct_ruji_swap_excluded'));
  context[0].events.unshift(event('wasm-rujira-revenue/run', { _contract_address: RUJI_SWAP_REVENUE_COLLECTOR, denom: 'rune' }));
  const excluded = parseRujiraBaseFeeBlock(28558676, { result: { txs_results: context, finalize_block_events: swaps } });
  assert.ok(excluded.events.every(row => !row.included && row.classification === 'ruji_swap_revenue_excluded'));
  setAttribute(memo, '_contract_address', RUJIRA_VS_CONTRACTS[0].address);
  const mismatched = parseRujiraBaseFeeBlock(28558676, { result: { txs_results: context, finalize_block_events: swaps } });
  assert.equal(mismatched.events.length, 0, 'a matching memo from another deployment is insufficient');
});

test('all VS sources share a bounded scan allowance and v2 starts at deployment despite the old websocket tip', async () => {
  const { ingestRujiraBaseFeeSources } = await import('../src/shared/rujira-base-fees.js');
  const client = createActionIngestClient({ maxHeight: 99999999 });
  const requests = [];
  const result = await ingestRujiraBaseFeeSources(client, {
    headMaxPages: 6, maxPages: 0, requestDelayMs: 0,
    fetchForwardPage: async (request, contract) => {
      requests.push({ ...request, contract: contract.key });
      if (contract.key === 'vs-v1-swap') throw new Error('legacy archive timeout');
      const action = midgardAction(contract.deployedHeight + 1);
      action.in[0].address = contract.address;
      return { actions: [action], meta: { prevPageToken: `more-${contract.key}` } };
    }
  });
  assert.equal(requests.length, 5, 'at most six forward attempts across all deployments, including failures');
  assert.deepEqual(requests[0], { fromHeight: 28519564, contract: 'vs-v2-swap' });
  assert.deepEqual(requests[2], { fromHeight: 28519564, contract: 'vs-v2-arb' });
  assert.equal(result.sources[0].actions, 2);
  assert.equal(result.sources[1].actions, 2);
  assert.equal(result.sources[2].head_catchup.error, 'legacy archive timeout');
  assert.deepEqual(new Set(client.savedStates.map(row => row.sync_key)), new Set(RUJIRA_VS_CONTRACTS.map(row => row.syncKey)));
  assert.equal(client.savedStates.find(row => row.sync_key === RUJIRA_VS_CONTRACTS[1].syncKey).stats_json.head_catchup.next_page_token, 'more-vs-v2-swap');
});

const acquisitionDatabaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const integration = acquisitionDatabaseUrl ? test : test.skip;
integration('v2 discovery durably resumes, reparses cached blocks once, deduplicates live/replay rows and reports unfinished coverage', async t => {
  assert.match(decodeURIComponent(new URL(acquisitionDatabaseUrl).pathname.slice(1)), /^(?:boonetools_)?acquisition_test(?:_|$)/);
  const { default: pg } = await import('pg');
  const { ingestRujiraBaseFeeActionPages, saveParsedRujiraBaseFeeBlock, getRujiraBaseFeesDashboardPayload } = await import('../src/shared/rujira-base-fees.js');
  const db = new pg.Client({ connectionString: acquisitionDatabaseUrl });
  await db.connect();
  t.after(() => db.end());
  for (const name of ['actions', 'blocks', 'events', 'sync_state', 'job_runs']) {
    await db.query(`create temporary table rujira_base_fee_${name} (like public.rujira_base_fee_${name} including all)`);
  }
  const source = RUJIRA_VS_CONTRACTS[1];
  await db.query(`insert into rujira_base_fee_sync_state (sync_key, next_page_token, complete)
    values ($1, 'legacy-history', false)`, [RUJIRA_VS_CONTRACTS[0].syncKey]);
  await db.query(`insert into rujira_base_fee_blocks (height, status, scan_json)
    values (28558676, 'fetched', '{}'), (99999999, 'fetched', '{}')`);
  await db.query(`insert into rujira_base_fee_actions (action_key, height, raw_action)
    select 'historical-' || n, 100000 + n, jsonb_build_object('in', jsonb_build_array(jsonb_build_object('address', $1::text)))
    from generate_series(1, 2000) n`, [RUJIRA_VS_CONTRACTS[0].address]);
  const action = midgardAction(28558676, '803B6D5277414548DA0CBF2C5C0DD9DD0BA2AA3317B79CD3B4A9CE9454C51D18');
  action.in[0].address = source.address;
  const settings = { contractKey: source.key, headMaxPages: 1, maxPages: 0, requestDelayMs: 0 };
  await ingestRujiraBaseFeeActionPages(db, { ...settings, fetchForwardPage: async request => {
    assert.deepEqual(request, { fromHeight: source.deployedHeight });
    return { actions: [action], meta: { prevPageToken: 'saved-v2-page' } };
  } });
  assert.equal((await db.query('select status from rujira_base_fee_blocks where height = 28558676')).rows[0].status, 'pending');
  await ingestRujiraBaseFeeActionPages(db, { ...settings, fetchForwardPage: async request => {
    assert.deepEqual(request, { prevPageToken: 'saved-v2-page' });
    return { actions: [], meta: { prevPageToken: '' } };
  } });
  let coverageQuery;
  const reportingClient = { query: async (sql, values) => {
    if (sql.includes('with action_heights')) coverageQuery = { sql, values };
    return db.query(sql, values);
  } };
  const coverage = async () => (await getRujiraBaseFeesDashboardPayload(reportingClient)).meta.trackedContracts.find(row => row.key === source.key);
  let tracked = await coverage();
  assert.equal(tracked.backfillComplete, true, 'action indexing is complete');
  assert.equal(tracked.pendingBlockCount, 1);
  assert.equal(tracked.feesReady, false, 'candidate block has not been parsed');
  const sourceMetadata = (await getRujiraBaseFeesDashboardPayload(reportingClient)).meta.trackedContracts;
  assert.equal(sourceMetadata.find(row => row.key === 'vs-v1-swap').candidateBlockCount, 2000, 'historical legacy coverage is retained');
  await db.query('analyze rujira_base_fee_actions');
  const plan = (await db.query(`explain (analyze, format json) ${coverageQuery.sql}`, coverageQuery.values)).rows[0]['QUERY PLAN'][0].Plan;
  const descendants = node => [node, ...(node.Plans || []).flatMap(descendants)];
  const jsonScans = descendants(plan).filter(node => node['Function Name'] === 'jsonb_array_elements');
  assert.ok(jsonScans.length > 0);
  assert.ok(jsonScans.every(node => node['Actual Loops'] <= 1), 'only the one post-deployment action expands JSON; historical payloads are never expanded');
  const fixture = realVsFixture(28558676);
  await saveParsedRujiraBaseFeeBlock(db, 28558676, fixture, { blockTime: '2026-11-06T12:00:00Z', source: 'ws' });
  await saveParsedRujiraBaseFeeBlock(db, 28558676, fixture, { blockTime: '2026-11-06T12:00:00Z', source: 'backfill' });
  tracked = await coverage();
  assert.equal(tracked.pendingBlockCount, 0);
  assert.equal(tracked.includedEventCount, 2, 'live and address replay share canonical event identities');
  assert.equal(tracked.unpricedEventCount, 2);
  assert.equal(tracked.feesReady, false, 'completed action paging does not claim unpriced USD fees are ready');
  await db.query('update rujira_base_fee_events set rune_price_usd = 0.6, liquidity_fee_usd = liquidity_fee_rune * 0.6');
  assert.equal((await coverage()).feesReady, true);
  await ingestRujiraBaseFeeActionPages(db, { ...settings, fetchForwardPage: async request => {
    assert.deepEqual(request, { fromHeight: 28558676 });
    return { actions: [action], meta: { prevPageToken: '' } };
  } });
  assert.equal((await db.query('select status from rujira_base_fee_blocks where height = 28558676')).rows[0].status, 'fetched', 'same candidate is not requeued after the current parser has processed it');
  assert.equal((await db.query('select next_page_token from rujira_base_fee_sync_state where sync_key = $1', [RUJIRA_VS_CONTRACTS[0].syncKey])).rows[0].next_page_token, 'legacy-history');
  await db.query("update rujira_base_fee_blocks set status = 'error' where height = 28558676");
  tracked = await coverage();
  assert.equal(tracked.errorBlockCount, 1);
  assert.equal(tracked.feesReady, false);
});


integration('dashboard distinguishes unpriced positive fees from true zero across all aggregations', async t => {
  const { default: pg } = await import('pg');
  const { getRujiraBaseFeesDashboardPayload } = await import('../src/shared/rujira-base-fees.js');
  const db = new pg.Client({ connectionString: acquisitionDatabaseUrl });
  await db.connect();
  t.after(() => db.end());
  for (const name of ['actions', 'blocks', 'events', 'sync_state', 'job_runs']) {
    await db.query(`create temporary table rujira_base_fee_${name} (like public.rujira_base_fee_${name} including all)`);
  }
  const source = RUJIRA_VS_CONTRACTS[1];
  const entries = [
    ['priced-before', '2026-10-25T12:00:00Z', 2, 0.5, 'BTC.BTC'],
    ['priced-mixed', '2026-11-03T12:00:00Z', 4, 0.6, 'BTC.BTC'],
    ['unpriced', '2026-11-03T13:00:00Z', 3, 0, 'BTC.BTC'],
    ['zero-fee', '2026-11-04T12:00:00Z', 0, 0, 'ETH.ETH'],
    ['priced-after', '2026-11-10T12:00:00Z', 5, 0.7, 'ETH.ETH']
  ];
  for (const [key, time, fee, price, pool] of entries) {
    await db.query(`insert into rujira_base_fee_events
      (event_key, canonical_key, height, block_time, liquidity_fee_rune, rune_price_usd,
       liquidity_fee_usd, included, from_address, pool, classification)
      values ($1, $1, 28558676, $2, $3, $4, $3::double precision * $4::double precision, true, $5, $6, $6)`,
    [key, time, fee, price, source.address, pool]);
  }
  const payload = await getRujiraBaseFeesDashboardPayload(db);
  assert.equal(payload.meta.totalLiquidityFeeRune, 14);
  assert.equal(payload.meta.totalLiquidityFeeUsd, null, 'partial USD must not masquerade as the total');
  assert.equal(payload.meta.pricedLiquidityFeeUsd, 6.9);
  assert.equal(payload.meta.unpricedEventCount, 1);
  assert.equal(payload.meta.unpricedFeeRune, 3);
  assert.equal(payload.meta.pricingComplete, false);
  assert.equal(payload.meta.trackedContracts.find(row => row.key === source.key).unpricedEventCount, 1);
  for (const rows of [payload.daily, payload.weekly, payload.routes, payload.pools]) {
    const mixed = rows.find(row => row.unpriced_events === 1);
    assert.ok(mixed, 'each grouping discloses the missing positive-fee event');
    assert.equal(mixed.liquidity_fee_usd, null);
    assert.equal(mixed.pricing_complete, false);
    assert.equal(mixed.unpriced_fee_rune, 3);
    assert.ok(mixed.priced_fee_usd > 0, 'priced subtotal remains available');
  }
  assert.equal(payload.daily.find(row => row.day_start === '2026-11-03').priced_fee_usd, 2.4);
  assert.equal(payload.daily.find(row => row.day_start === '2026-11-04').liquidity_fee_usd, 0);
  assert.equal(payload.daily.find(row => row.day_start === '2026-11-04').pricing_complete, true);
  for (const rows of [payload.daily, payload.weekly]) {
    assert.equal(rows[0].cumulative_usd, 1);
    assert.equal(rows.at(-1).liquidity_fee_usd, 3.5);
    assert.equal(rows.at(-1).cumulative_usd, null, 'later priced buckets do not close an earlier gap');
    assert.equal(rows.at(-1).cumulative_priced_usd, 6.9);
    assert.equal(rows.at(-1).cumulative_unpriced_events, 1);
    assert.equal(rows.at(-1).cumulative_unpriced_fee_rune, 3);
    assert.equal(rows.at(-1).cumulative_pricing_complete, false);
  }
  const byKey = Object.fromEntries(payload.recent_events.map(row => [row.event_key, row]));
  assert.equal(byKey.unpriced.liquidity_fee_usd, null);
  assert.equal(byKey.unpriced.unpriced_events, 1);
  assert.equal(byKey.unpriced.priced_fee_usd, 0);
  assert.equal(byKey['zero-fee'].liquidity_fee_usd, 0);
  assert.equal(byKey['zero-fee'].unpriced_events, 0);
  assert.equal(byKey['zero-fee'].pricing_complete, true);
  assert.equal(byKey['priced-before'].liquidity_fee_usd, 1);

  // Normal price recovery fills only missing values; existing native and USD
  // amounts remain unchanged and cumulative completeness can recover naturally.
  await db.query("update rujira_base_fee_events set rune_price_usd = 0.6, liquidity_fee_usd = 1.8 where event_key = 'unpriced'");
  const recovered = await getRujiraBaseFeesDashboardPayload(db);
  assert.equal(recovered.meta.totalLiquidityFeeRune, 14);
  assert.equal(recovered.meta.totalLiquidityFeeUsd, 8.7);
  assert.equal(recovered.meta.unpricedEventCount, 0);
  assert.equal(recovered.meta.pricingComplete, true);
  assert.equal(recovered.daily.at(-1).cumulative_usd, 8.7);
  assert.equal(recovered.weekly.at(-1).cumulative_usd, 8.7);
});
