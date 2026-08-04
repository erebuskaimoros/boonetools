import assert from 'node:assert/strict';
import test from 'node:test';

function event(type, attrs) {
  return {
    type,
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: String(value)
    }))
  };
}

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

test('buildRujiraBaseFeeRowsFromDune normalizes Dune generated-fee rows', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    RUJIRA_THORCHAIN_SWAP_CONTRACT,
    buildRujiraBaseFeeRowsFromDune
  } = await import('../src/shared/rujira-base-fees.js');

  const [row] = buildRujiraBaseFeeRowsFromDune([{
    event_key: 'dune-row-1',
    height: 25999025,
    block_time: '2026-05-01 23:11:49.000 UTC',
    swap_id: '5ec55ce39298d90299b955df0b7149da389a9ce1ae33d9bbf75414b9c04e7ddc',
    pool: 'THOR.RUJI',
    chain: 'THOR',
    from_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
    to_address: 'thor1dest',
    coin: '16.999151 THOR.RUNE',
    memo: '=:THOR.RUJI:thor1dest:0/1/1',
    liquidity_fee_base: 1699960,
    liquidity_fee_rune: 0.0169996,
    rune_price_usd: 0.5084920729,
    liquidity_fee_usd: 0.0086441618,
    classification: 'fin_base_layer_execution',
    included: true,
    source_contract: 'thor1fin',
    source_label: 'RUJI Trade / FIN thor1fin...',
    source_denom: '',
    source: 'dune'
  }]);

  assert.equal(row.event_key, row.canonical_key);
  assert.match(row.event_key, /^rujira-base-fee:v2\|25999025\|5EC55CE/);
  assert.equal(row.height, 25999025);
  assert.equal(row.block_time, '2026-05-01T23:11:49.000+00:00');
  assert.equal(row.swap_id, '5EC55CE39298D90299B955DF0B7149DA389A9CE1AE33D9BBF75414B9C04E7DDC');
  assert.equal(row.included, true);
  assert.equal(row.classification, 'fin_base_layer_execution');
  assert.equal(row.liquidity_fee_base, '1699960');
  assert.equal(row.source, 'dune');
  assert.equal(row.raw_event.source, 'dune');
  assert.equal(row.raw_event.source_event_key, 'dune-row-1');
  assert.equal(row.context_json.query_id, '7620091');
});

test('Dune generated-fee rows must satisfy the Rujira swap and classification invariants', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    RUJIRA_THORCHAIN_SWAP_CONTRACT,
    buildRujiraBaseFeeRowsFromDune
  } = await import('../src/shared/rujira-base-fees.js');
  const valid = {
    event_key: 'dune-valid-row',
    height: 25999025,
    block_time: '2026-05-01T23:11:49.000Z',
    swap_id: '5ec55ce39298d90299b955df0b7149da389a9ce1ae33d9bbf75414b9c04e7ddc',
    pool: 'THOR.RUJI',
    chain: 'THOR',
    from_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
    to_address: 'thor1dest',
    coin: '16.999151 THOR.RUNE',
    memo: '=:THOR.RUJI:thor1dest:0/1/1',
    liquidity_fee_base: '1699960',
    liquidity_fee_rune: 0.0169996,
    rune_price_usd: 0.5084920729,
    liquidity_fee_usd: 0.0086441618,
    classification: 'fin_base_layer_execution',
    included: true,
    source_contract: 'thor1fin',
    source: 'dune'
  };

  assert.equal(buildRujiraBaseFeeRowsFromDune([valid]).length, 1);
  assert.equal(buildRujiraBaseFeeRowsFromDune([{
    ...valid,
    event_key: 'wrong-sender',
    from_address: 'thor1notrujira'
  }]).length, 0);
  assert.equal(buildRujiraBaseFeeRowsFromDune([{
    ...valid,
    event_key: 'wrong-inclusion',
    included: false
  }]).length, 0);
  assert.equal(buildRujiraBaseFeeRowsFromDune([{
    ...valid,
    event_key: 'wrong-fee',
    liquidity_fee_rune: 9
  }]).length, 0);
  assert.equal(buildRujiraBaseFeeRowsFromDune([{
    ...valid,
    event_key: 'wrong-collector-classification',
    source_contract: RUJIRA_THORCHAIN_SWAP_CONTRACT
  }]).length, 0);

  const directRujiSwapAuditRow = {
    ...valid,
    event_key: 'direct-ruji-swap-audit-row',
    swap_id: `${valid.swap_id}-1`,
    memo: '',
    classification: 'direct_ruji_swap_excluded',
    included: false,
    source_contract: RUJIRA_THORCHAIN_SWAP_CONTRACT
  };
  const [normalizedDirectRujiSwapAuditRow] = buildRujiraBaseFeeRowsFromDune([directRujiSwapAuditRow]);
  assert.equal(normalizedDirectRujiSwapAuditRow.swap_id, `${valid.swap_id.toUpperCase()}-1`);
  assert.equal(normalizedDirectRujiSwapAuditRow.memo, '');

  assert.equal(buildRujiraBaseFeeRowsFromDune([{
    ...directRujiSwapAuditRow,
    event_key: 'direct-ruji-swap-skipped-memo',
    memo: '%%skipped%% missing final event'
  }]).length, 0);
});

test('legacy and Dune rows share a canonical event identity and retain both providers on upsert', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    RUJIRA_THORCHAIN_SWAP_CONTRACT,
    buildRujiraBaseFeeRowsFromDune,
    parseRujiraBaseFeeBlock,
    saveRujiraBaseFeeEvents
  } = await import('../src/shared/rujira-base-fees.js');
  const swapId = '5ec55ce39298d90299b955df0b7149da389a9ce1ae33d9bbf75414b9c04e7ddc';
  const memo = '=:THOR.RUJI:thor1dest:0/1/1';
  const [legacy] = parseRujiraBaseFeeBlock(25999025, {
    result: {
      txs_results: [{
        events: [
          event('wasm-rujira-fin/trade', {
            _contract_address: 'thor1fin',
            offer: '1699915100',
            bid: '1'
          }),
          event('wasm-rujira-thorchain-swap/swap', {
            _contract_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
            amount: '1699915100rune',
            memo
          })
        ]
      }],
      finalize_block_events: [
        event('swap', {
          id: swapId,
          from: RUJIRA_THORCHAIN_SWAP_CONTRACT,
          to: 'thor1dest',
          pool: 'THOR.RUJI',
          chain: 'THOR',
          coin: '1699915100 THOR.RUNE',
          memo,
          liquidity_fee_in_rune: '1699960'
        })
      ]
    }
  }, {
    blockTime: '2026-05-01T23:11:49.000Z'
  }).events;
  const [dune] = buildRujiraBaseFeeRowsFromDune([{
    event_key: 'dune-row-for-same-swap',
    height: 25999025,
    block_time: '2026-05-01T23:11:49.000Z',
    swap_id: swapId,
    pool: 'THOR.RUJI',
    chain: 'THOR',
    from_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
    to_address: 'thor1dest',
    coin: '16.999151 THOR.RUNE',
    memo,
    liquidity_fee_base: '1699960',
    liquidity_fee_rune: 0.0169996,
    rune_price_usd: 0.5084920729,
    liquidity_fee_usd: 0.0086441618,
    classification: 'fin_base_layer_execution',
    included: true,
    source_contract: 'thor1fin',
    source: 'dune'
  }]);

  assert.equal(legacy.canonical_key, dune.canonical_key);
  assert.equal(legacy.event_key, dune.event_key);

  const queries = [];
  const saved = await saveRujiraBaseFeeEvents({
    query: async (...args) => {
      queries.push(args);
      return { rows: [], rowCount: 1 };
    }
  }, [legacy, dune]);

  assert.equal(saved, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0][0], /on conflict \(canonical_key\) do update/i);
  assert.match(queries[0][0], /source_provenance/i);
  assert.ok(queries[0][1].some((value) => typeof value === 'string'
    && value.includes('"dune"')
    && value.includes('"legacy"')));
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
