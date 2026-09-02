import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDuneTcFeeRows, fetchMidgardTcFeeRows } from '../src/shared/tc-fee-dash-ingestion.js';
import { ingestBurnTrackerHistory } from '../src/shared/burn-tracker-ingestion.js';
import { wasmRuntimeOptions, fetchPriceIntervals, priceRujiraFeeEvents, scanCandidateBlocks } from '../src/shared/wasm-arb-economics-ingestion.js';

test('TC Fee fallback reuses successful same-window CMC and swap acquisitions', async () => {
  let cmcCalls = 0;
  let swapCalls = 0;
  const cmc = new Map([['2026-09-01', { cmcVolume24hUsd: 100, raw: {} }]]);
  const volumes = new Map([['2026-09-01', { thorchainVolumeUsd: 5, raw: { totalVolumeUSD: '500' } }]]);
  const common = { skipDelay: true, fetchCmc: async () => { cmcCalls++; return cmc; } };
  const primary = await fetchDuneTcFeeRows('2026-09-01', 1, { ...common,
    executeDune: async () => ({ rows: [], executionId: 'test' }),
    fetchSwapVolumes: async () => { swapCalls++; return volumes; } });
  await fetchMidgardTcFeeRows('2026-09-01', 1, { ...common, acquisition: primary.acquisition,
    fetchMidgard: async () => ({ intervals: [] }), fetchDex: async () => new Map(),
    fetchSwapHistory: async () => { swapCalls++; return { intervals: [] }; } });
  assert.equal(cmcCalls, 1);
  assert.equal(swapCalls, 1);
});

test('Wasm independent lanes reuse a fresh durable head before provider lookup', async () => {
  let providerCalls = 0;
  const runtime = await wasmRuntimeOptions({}, {
    resolveHead: async () => ({ height: 123, source: 'stored' }),
    fetchThorchain: async () => { providerCalls++; return [{ thorchain: 123 }]; }
  }, 'fees');
  assert.equal(runtime.latestHeight, 123);
  assert.equal(providerCalls, 0);
});

test('Wasm completed five-minute prices survive later runs without another history call', async () => {
  const records = new Map();
  const start = Date.parse('2026-09-01T12:00:00Z') / 1000;
  let historyCalls = 0;
  const options = { client: {}, skipDelay: true, healthNow: '2026-09-02T12:00:00Z',
    loadAcquisition: async (_client, namespace, key) => records.get(`${namespace}:${key}`),
    saveAcquisition: async (_client, row) => { records.set(`${row.namespace}:${row.identity}`, row); },
    fetchMidgard: async (path) => {
      if (path === '/health') return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: start + 600 } };
      historyCalls++;
      return { intervals: [{ startTime: String(start), endTime: String(start + 300), assetPriceUSD: '2' }] };
    }
  };
  assert.equal((await fetchPriceIntervals('BTC.BTC', start, start, options)).get(start), 2);
  assert.equal((await fetchPriceIntervals('BTC.BTC', start, start, options)).get(start), 2);
  assert.equal(historyCalls, 1);
});

test('Burn refresh skips completed history and recently reconciled all-time totals', async () => {
  const calls = [];
  const result = await ingestBurnTrackerHistory({}, {
    now: '2026-09-02T12:00:00Z', configuredStartDate: '2026-09-01',
    loadCoverage: async () => ({ first_day: '2026-09-01' }),
    loadPendingDays: async () => [],
    getSyncState: async () => ({ stats_json: { reconciled_at: '2026-09-02T11:00:00Z', all_time_burn_e8: '15' } }),
    loadTotals: async () => ({ complete: true, completed_burn_e8: '10', current_burn_e8: '7' }),
    fetchDaily: async () => { calls.push('history'); return { rows: [], pages: 1 }; },
    fetchCurrent: async () => { calls.push('current'); return { day: '2026-09-02', burn_e8: '7', partial: true }; },
    fetchAllTime: async () => { calls.push('all-time'); return { burn_e8: '17' }; },
    upsert: async () => 1, updateSyncState: async () => {}
  });
  assert.deepEqual(calls, ['current']);
  assert.equal(result.derived_total_burn_e8, '17');
});

function burnOptions(overrides = {}) {
  return {
    now: '2026-09-02T12:00:00Z', healthNow: '2026-09-02T12:01:00Z', configuredStartDate: '2026-09-01',
    getSyncState: async () => ({ stats_json: { reconciled_at: '2026-09-02T11:00:00Z', all_time_burn_e8: '17' } }),
    loadPendingDays: async () => ['2026-09-01'],
    loadTotals: async () => ({ complete: false, completed_burn_e8: '0', current_burn_e8: '7' }),
    fetchCurrent: async () => ({ day: '2026-09-02', burn_e8: '7', partial: true }),
    fetchAllTime: async () => ({ burn_e8: '17' }),
    fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 1, timestamp: Date.parse('2026-09-02T12:00:30Z') / 1000 } }),
    upsert: async () => 1, updateSyncState: async () => {}, ...overrides
  };
}
function burnRow(overrides = {}) {
  return { day: '2026-09-01', burn_e8: '0', rune_price_usd: null,
    interval_start: '2026-09-01T00:00:00Z', interval_end: '2026-09-02T00:00:00Z',
    source_json: { pools: [] }, ...overrides };
}

test('Burn never freezes a malformed income_burn amount as a completed zero day', async () => {
  const saved = [];
  await ingestBurnTrackerHistory({}, burnOptions({
    fetchDaily: async () => ({ pages: 1, rows: [burnRow({ source_json: { pools: [{ pool: 'income_burn', earnings: 'invalid' }] } })] }),
    upsert: async (_client, rows) => { saved.push(...rows); return rows.length; }
  }));
  assert.equal(saved.find((row) => row.day === '2026-09-01').completed_at, null);
});

test('Burn validates closed days against receipt-time health on the same provider', async () => {
  const saved = [];
  let healthBases;
  await ingestBurnTrackerHistory({}, burnOptions({
    historyBase: 'https://example.invalid/v2',
    fetchMidgard: async (_path, options) => {
      healthBases = options.bases;
      return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: Date.parse('2026-09-02T12:00:30Z') / 1000 } };
    },
    fetchDaily: async (options) => { assert.deepEqual(options.bases, healthBases); return { pages: 1, rows: [burnRow()] }; },
    upsert: async (_client, rows) => { saved.push(...rows); return rows.length; }
  }));
  assert.ok(saved.find((row) => row.day === '2026-09-01').completed_at);
});

test('Burn keeps live updates when historical and all-time calls fail', async () => {
  const saved = [];
  let sync;
  const result = await ingestBurnTrackerHistory({}, burnOptions({
    fetchDaily: async () => { throw new Error('archive unavailable'); },
    fetchAllTime: async () => { throw new Error('audit unavailable'); },
    upsert: async (_client, rows) => { saved.push(...rows); return rows.length; },
    updateSyncState: async (_client, state) => { sync = state; }
  }));
  assert.deepEqual(saved.map((row) => row.day), ['2026-09-02']);
  assert.equal(result.all_time_burn_e8, '17');
  assert.equal(result.baseline_complete, false);
  assert.match(sync.lastError, /archive unavailable.*audit unavailable/);
});

test('Wasm unfinished bucket prices are never saved as immutable observations', async () => {
  const start = Date.parse('2026-09-01T12:00:00Z') / 1000;
  const saved = [];
  const price = await fetchPriceIntervals('BTC.BTC', start, start, {
    client: {}, skipDelay: true, healthNow: '2026-09-01T12:02:00Z',
    loadAcquisition: async () => null, saveAcquisition: async (_client, row) => saved.push(row),
    fetchMidgard: async (path) => path === '/health'
      ? { database: true, inSync: true, lastAggregated: { height: 1, timestamp: start + 120 } }
      : { intervals: [{ startTime: String(start), endTime: String(start + 300), assetPriceUSD: '2' }] }
  });
  assert.equal(price.get(start), 2);
  assert.deepEqual(saved, []);
});

test('Wasm saves completed price pages even when a later missing range fails', async () => {
  const start = Date.parse('2026-09-01T12:00:00Z') / 1000;
  const second = start + 600;
  const cache = new Map();
  const historyStarts = [];
  let failure = true;
  const options = { client: {}, skipDelay: true, requiredBuckets: [start, second], healthNow: '2026-09-02T12:00:00Z',
    loadAcquisition: async (_client, namespace, key) => cache.get(`${namespace}:${key}`),
    saveAcquisition: async (_client, row) => cache.set(`${row.namespace}:${row.identity}`, row),
    fetchMidgard: async (path) => {
      if (path === '/health') return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: second + 600 } };
      const from = Number(new URL(path, 'https://example.invalid').searchParams.get('from'));
      historyStarts.push(from);
      if (from === second && failure) throw new Error('later page unavailable');
      return { intervals: [{ startTime: String(from), endTime: String(from + 300), assetPriceUSD: '2' }] };
    }
  };
  await assert.rejects(fetchPriceIntervals('BTC.BTC', start, second, options), /later page unavailable/);
  failure = false;
  assert.equal((await fetchPriceIntervals('BTC.BTC', start, second, options)).size, 2);
  assert.deepEqual(historyStarts, [start, second, second]);
});

test('Wasm requests only the missing time buckets needed by each fee denomination', async () => {
  const first = Date.parse('2026-09-01T12:00:00Z') / 1000;
  const last = Date.parse('2026-09-01T18:00:00Z') / 1000;
  const feeRows = [
    { event_key: 'wasm-arb-rujira-fee:v2:a', block_time: new Date(first * 1000).toISOString(), denom: 'btc-btc', amount: 1, raw_event: {} },
    { event_key: 'wasm-arb-rujira-fee:v2:b', block_time: new Date(last * 1000).toISOString(), denom: 'eth-eth', amount: 1, raw_event: {} }
  ];
  const requests = [];
  const client = { query: async (sql) => {
    if (sql.includes('from wasm_arb_economics_rujira_fees')) return { rows: feeRows };
    return { rows: [], rowCount: 2 };
  } };
  const result = await priceRujiraFeeEvents(client, {
    skipDelay: true, healthNow: '2026-09-02T00:00:00Z', loadAcquisition: async () => null,
    saveAcquisition: async () => {}, isMissingPoolPriceCached: async () => false,
    fetchMidgard: async (path) => {
      if (path === '/health') return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: last + 600 } };
      const url = new URL(path, 'https://example.invalid');
      const from = Number(url.searchParams.get('from'));
      requests.push([decodeURIComponent(url.pathname), from, Number(url.searchParams.get('to'))]);
      return { intervals: [{ startTime: String(from), endTime: String(from + 300), assetPriceUSD: '2' }] };
    }
  });
  assert.equal(result.priced, 2);
  assert.deepEqual(requests, [['/history/depths/BTC.BTC', first, first + 300], ['/history/depths/ETH.ETH', last, last + 300]]);
});

test('Wasm block-result parsing reuses the shared exact-height timestamp', async () => {
  const calls = [];
  const result = await scanCandidateBlocks({ query: async (sql) => sql.includes('from wasm_arb_economics_blocks')
    ? { rows: [{ height: 27181680, block_time: null, attempts: 0 }] } : { rows: [], rowCount: 1 } }, {
    fetchThorchain: async () => ({ contracts: [] }),
    resolveBlockTime: async (_client, height) => { assert.equal(height, 27181680); return '2026-07-27T14:04:51Z'; },
    fetchRpc: async (path) => { calls.push(path); return { result: { txs_results: [] } }; }
  });
  assert.equal(result.failures, 0);
  assert.deepEqual(calls, ['/block_results']);
});

test('TC Fee acquisitions are reused only for the identical requested window', async () => {
  let cmc = 0;
  let swaps = 0;
  await fetchMidgardTcFeeRows('2026-09-02', 1, {
    acquisition: { startDate: '2026-09-01', count: 1, cmcVolumesByDate: new Map(), thorchainVolumesByDate: new Map() },
    fetchMidgard: async () => ({ intervals: [] }), fetchDex: async () => new Map(),
    fetchCmc: async () => { cmc++; return new Map(); },
    fetchSwapHistory: async () => { swaps++; return { intervals: [] }; }
  });
  assert.equal(cmc, 1);
  assert.equal(swaps, 1);
});
