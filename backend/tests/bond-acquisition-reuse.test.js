import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNodeAtHeight, fetchNetworkAtHeight, processChurn } from '../src/shared/bond-history-acquisition.js';

function memoryAcquisition() {
  const cache = new Map();
  return async (_client, options) => {
    const key = `${options.namespace}:${JSON.stringify(options.identity)}`;
    if (cache.has(key)) return cache.get(key);
    const payload = await options.load({});
    if (options.validate && !options.validate(payload)) throw new Error('invalid payload');
    const result = { payload, completedAt: '2026-09-01T00:00:00Z' };
    cache.set(key, result);
    return result;
  };
}
const node = { node_address: 'thor1node', current_award: '100', bond_providers: { node_operator_fee: '0', providers: [] } };

test('Bond raw historical node and network observations are shared across consumers', async () => {
  let requests = 0;
  const options = { acquireCached: memoryAcquisition(), fetchThorchain: async (path) => {
    requests++;
    return path.includes('/node/') ? node : { rune_price_in_tor: '100000000' };
  } };
  for (let consumer = 0; consumer < 2; consumer++) {
    await fetchNodeAtHeight('thor1node', 99, options);
    await fetchNetworkAtHeight(100, options);
  }
  assert.equal(requests, 2);
});

test('Bond proven empty churns are durable only for the exact node set', async () => {
  const completed = new Map();
  let reads = 0;
  const options = {
    loadAcquisition: async (_client, namespace, identity) => completed.get(`${namespace}:${identity}`),
    saveAcquisition: async (_client, row) => completed.set(`${row.namespace}:${row.identity}`, row),
    acquireCached: async (_client, acquisition) => ({ payload: await acquisition.load({}) }),
    fetchThorchain: async (path) => { reads++; return path.includes('/network') ? { rune_price_in_tor: '100000000' }
      : { ...node, node_address: path.match(/\/node\/([^?]+)/)[1] }; }
  };
  await processChurn('thor1bond', ['thor1node'], 100, 10, null, options);
  await processChurn('thor1bond', ['thor1node'], 100, 10, null, options);
  assert.equal(reads, 2);
  await processChurn('thor1bond', ['thor1other'], 100, 10, null, options);
  assert.equal(reads, 4);
});

const { scanBondActionWindow } = await import('../src/shared/bond-history-acquisition.js');
test('Bond action refresh queries only the window after verified coverage', async () => {
  const through = Date.parse('2026-09-01T12:00:00Z') / 1000;
  const requests = [];
  const result = await scanBondActionWindow('thor1bond', {
    coveredThrough: through, coveredSourceKey: 'test-provider', sourceKey: 'test-provider',
    healthNow: '2026-09-02T12:00:00Z',
    fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 2, timestamp: through + 600 } }),
    fetchActions: async (params) => { requests.push(params); return { actions: [] }; }
  });
  assert.equal(requests[0].fromTimestamp, through - 1);
  assert.equal(requests[0].timestamp, through + 600);
  assert.equal(result.coveredThrough, through + 600);
});

test('Bond action pagination resumes the same verified window after hitting the budget', async () => {
  const through = Date.parse('2026-09-01T12:00:00Z') / 1000;
  const requests = [];
  const options = { maxPages: 1, sourceKey: 'test-provider', healthNow: '2026-09-02T12:00:00Z',
    fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 2, timestamp: through } }),
    fetchActions: async (params) => {
      requests.push(params);
      return { actions: requests.length === 1 ? Array.from({ length: 50 }, (_, i) => ({ height: 100 - i })) : [] };
    }
  };
  const first = await scanBondActionWindow('thor1bond', options);
  assert.equal(first.complete, false);
  assert.equal(first.coveredThrough, null);
  const second = await scanBondActionWindow('thor1bond', { ...options, progress: first.progress });
  assert.equal(requests[1].offset, 50);
  assert.equal(requests[1].timestamp, requests[0].timestamp);
  assert.equal(second.complete, true);
  assert.equal(second.coveredThrough, through);
});

test('Bond failed page keeps prior full-page progress without advancing coverage', async () => {
  const until = Date.parse('2026-09-01T12:00:00Z') / 1000;
  const result = await scanBondActionWindow('thor1bond', {
    sourceKey: 'test-provider', progress: { sourceKey: 'test-provider', from: 0, until, offset: 100 },
    fetchActions: async () => { throw new Error('429'); }
  });
  assert.equal(result.complete, false);
  assert.equal(result.coveredThrough, null);
  assert.equal(result.progress.offset, 100);
  assert.equal(result.progress.until, until);
});

test('Bond source changes reset partial-window pagination and covered boundaries', async () => {
  const until = Date.parse('2026-09-01T12:00:00Z') / 1000;
  const requests = [];
  await scanBondActionWindow('thor1bond', {
    sourceKey: 'new-provider', coveredSourceKey: 'old-provider', coveredThrough: until - 10,
    progress: { sourceKey: 'old-provider', from: 0, until, offset: 100 }, healthNow: '2026-09-02T00:00:00Z',
    fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 1, timestamp: until } }),
    fetchActions: async (params) => { requests.push(params); return { actions: [] }; }
  });
  assert.equal(requests[0].fromTimestamp, 0);
  assert.equal(requests[0].offset, 0);
});

test('Bond a failed node cannot be recorded as proof of an empty churn', async () => {
  let saved = 0;
  const result = await processChurn('thor1bond', ['thor1node'], 100, 10, null, {
    loadAcquisition: async () => null, saveAcquisition: async () => { saved++; },
    acquireCached: async (_client, acquisition) => ({ payload: await acquisition.load({}) }),
    fetchThorchain: async (path) => {
      if (path.includes('/node/')) throw new Error('Request failed (404)');
      return { rune_price_in_tor: '100000000' };
    }
  });
  assert.equal(result, null);
  assert.equal(saved, 0);
});
