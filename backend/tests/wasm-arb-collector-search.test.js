import assert from 'node:assert/strict';
import test from 'node:test';

import { config } from '../src/lib/config.js';
import { scanCollectorSearchPages } from '../src/shared/wasm-arb-economics-ingestion.js';

const START = config.wasmArbEconomicsStartHeight;
const HEAD = 'collector-tx-search';

function store(initial = {}) {
  const states = new Map(Object.entries(initial));
  const queued = [];
  return {
    states,
    queued,
    async query(sql, params = []) {
      if (sql.includes('from wasm_arb_economics_sync_state')) {
        return { rows: states.has(params[0]) ? [structuredClone(states.get(params[0]))] : [] };
      }
      if (sql.includes('insert into wasm_arb_economics_sync_state')) {
        const [sync_key, cursor_value, next_page_token, complete, stats_json] = params;
        states.set(sync_key, structuredClone({
          sync_key, cursor_value, next_page_token, complete, stats_json
        }));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('insert into wasm_arb_economics_blocks')) {
        queued.push(...JSON.parse(params[0]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

function txs(height, count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    height: String(height - i), tx_result: { code: 0 }
  }));
}

function headOptions(fetchCollectorTxSearchPage, overrides = {}) {
  return {
    syncKey: HEAD,
    kind: 'tx',
    backfill: false,
    maxPages: 1,
    latestHeight: 27658737,
    fetchCollectorTxSearchPage,
    ...overrides
  };
}

test('collector head applies its proven overlap boundary in the RPC query', async () => {
  const client = store({ [HEAD]: { stats_json: {
    scanned_through_height: 27658000,
    max_height: 27658600
  } } });
  const calls = [];
  await scanCollectorSearchPages(client, headOptions(undefined, {
    async fetchRpc(route, params) {
      calls.push({ route, params });
      return { result: { txs: txs(27658700), total_count: '1' } };
    }
  }));

  assert.equal(calls[0].route, '/tx_search');
  assert.match(calls[0].params.query, /tx\.height>=27656800 AND tx\.height<=27658737/);
  assert.equal(client.states.get(HEAD).stats_json.scanned_through_height, 27658737);
  assert.equal(client.states.get(HEAD).cursor_value, '27658737');
  assert.equal(client.states.get(HEAD).stats_json.max_height, 27658700);
});

test('legacy head bootstraps bounded catch-up from completed archive, never maximum observed match', async () => {
  const client = store({
    [HEAD]: { stats_json: { max_height: 27590106, target_height: 27658737 } },
    [`${HEAD}-backfill`]: {
      complete: true, stats_json: { target_height: 27266716, max_height: 27266707 }
    }
  });
  const calls = [];
  await scanCollectorSearchPages(client, headOptions(async (params) => {
    calls.push(params);
    return { txs: [], total_count: '0' };
  }, { maxPages: 2 }));

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ startHeight, endHeight, page }) => ({
    startHeight, endHeight, page
  })), [
    { startHeight: 27265516, endHeight: 27275515, page: 1 },
    { startHeight: 27275516, endHeight: 27285515, page: 1 }
  ]);
  const saved = client.states.get(HEAD);
  assert.equal(saved.stats_json.scanned_through_height, 27285515);
  assert.equal(saved.stats_json.latest_height, 27658737);
  assert.equal(saved.stats_json.max_height, 27590106);
});

test('legacy head without completed archival coverage begins at activation in a bounded window', async () => {
  const client = store({
    [HEAD]: { stats_json: { max_height: 27658000 } },
    [`${HEAD}-backfill`]: { complete: false, stats_json: { max_height: 27657000 } }
  });
  const calls = [];
  await scanCollectorSearchPages(client, headOptions(async (params) => {
    calls.push(params);
    throw new Error('provider unavailable');
  }));
  assert.equal(calls[0].startHeight, START);
  assert.equal(calls[0].endHeight, START + 9999);
  assert.equal(client.states.get(HEAD).stats_json.scanned_through_height, START - 1);
});

for (const kind of ['tx', 'block']) {
  test(`empty successful ${kind} head ranges advance proven coverage even without matches`, async () => {
    const syncKey = `collector-${kind}-search`;
    const client = store({ [syncKey]: { stats_json: {
      scanned_through_height: 27658000, max_height: 27657000
    } } });
    const calls = [];
    const fetchPage = async (params) => {
      calls.push(params);
      return { txs: [], blocks: [], total_count: '0' };
    };
    const options = headOptions(fetchPage, {
      kind, syncKey, fetchCollectorBlockSearchPage: fetchPage
    });
    await scanCollectorSearchPages(client, options);
    await scanCollectorSearchPages(client, { ...options, latestHeight: 27658780 });

    assert.equal(calls[1].startHeight, 27658737 - 1200);
    assert.equal(client.states.get(syncKey).stats_json.scanned_through_height, 27658780);
    assert.equal(client.states.get(syncKey).stats_json.max_height, 27657000);
  });
}

test('head page budget preserves a fixed pending range and resumes without skipping its middle', async () => {
  const client = store({ [HEAD]: { stats_json: {
    scanned_through_height: 27654000, max_height: 27654000
  } } });
  const calls = [];
  await scanCollectorSearchPages(client, headOptions(async (params) => {
    calls.push(params);
    return { txs: txs(27658700, 100), total_count: '101' };
  }));
  const pending = client.states.get(HEAD);
  assert.equal(pending.next_page_token, '2');
  assert.equal(pending.cursor_value, '27654000');
  assert.equal(pending.stats_json.scanned_through_height, 27654000);

  await scanCollectorSearchPages(client, headOptions(async (params) => {
    calls.push(params);
    return { txs: txs(27655000), total_count: '101' };
  }, { latestHeight: 27659000 }));
  assert.deepEqual(calls.map(({ startHeight, endHeight, page }) => ({
    startHeight, endHeight, page
  })), [
    { startHeight: 27652800, endHeight: 27658737, page: 1 },
    { startHeight: 27652800, endHeight: 27658737, page: 2 }
  ]);
  assert.equal(client.states.get(HEAD).stats_json.scanned_through_height, 27658737);
  assert.equal(client.states.get(HEAD).next_page_token, '');
  assert.ok(client.queued.some(({ height }) => height === 27655000));
});

test('failed head page resumes the same window despite newer maximum observed heights', async () => {
  const client = store({ [HEAD]: { stats_json: {
    scanned_through_height: 27654000, max_height: 27654000
  } } });
  const calls = [];
  const result = await scanCollectorSearchPages(client, headOptions(async (params) => {
    calls.push(params);
    if (params.page === 2) throw new Error('provider deadline');
    return { txs: txs(27658700, 100), total_count: '101' };
  }, { maxPages: 2 }));
  assert.deepEqual(result.errors, ['provider deadline']);
  assert.equal(client.states.get(HEAD).next_page_token, '2');
  assert.equal(client.states.get(HEAD).stats_json.scanned_through_height, 27654000);

  await scanCollectorSearchPages(client, headOptions(async (params) => {
    calls.push(params);
    return { txs: txs(27655000), total_count: '101' };
  }, { latestHeight: 27660000 }));
  assert.deepEqual(calls[2], calls[1]);
  assert.equal(client.states.get(HEAD).stats_json.scanned_through_height, 27658737);
});

test('pending head window above a temporarily lower tip is retained without requesting or skipping it', async () => {
  const client = store({ [HEAD]: {
    next_page_token: '2',
    stats_json: {
      scanned_through_height: 27654000,
      scan_start_height: 27652800,
      target_height: 27658737,
      max_height: 27658700
    }
  } });
  let calls = 0;
  const result = await scanCollectorSearchPages(client, headOptions(async () => {
    calls += 1;
    return { txs: [], total_count: '0' };
  }, { latestHeight: 27658000 }));
  assert.equal(calls, 0);
  assert.ok(result.errors.length > 0);
  assert.equal(client.states.get(HEAD).next_page_token, '2');
  assert.equal(client.states.get(HEAD).stats_json.scanned_through_height, 27654000);
  assert.equal(client.states.get(HEAD).stats_json.target_height, 27658737);
});

test('archival pagination retains its activation boundary and original target height', async () => {
  const syncKey = `${HEAD}-backfill`;
  const client = store({ [syncKey]: {
    next_page_token: '3', complete: false,
    stats_json: { target_height: 27266716, max_height: 27266000 }
  } });
  const calls = [];
  await scanCollectorSearchPages(client, headOptions(async (params) => {
    calls.push(params);
    return { txs: txs(27266600, 100), total_count: '400' };
  }, { syncKey, backfill: true }));

  assert.deepEqual(calls, [{
    kind: 'tx', page: 3, startHeight: START, endHeight: 27266716,
    orderBy: 'asc', backfill: true
  }]);
  assert.equal(client.states.get(syncKey).next_page_token, '4');
  assert.equal(client.states.get(syncKey).stats_json.target_height, 27266716);
  assert.equal(client.states.get(syncKey).complete, false);
});
