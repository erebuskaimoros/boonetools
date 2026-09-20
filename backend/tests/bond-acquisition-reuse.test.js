import test from 'node:test';
import assert from 'node:assert/strict';
import { BinaryReader, BinaryWriter } from 'cosmjs-types/binary.js';
import { fetchNodeAtHeight, fetchNetworkAtHeight, processChurn } from '../src/shared/bond-history-acquisition.js';

function memoryAcquisition(cache = new Map()) {
  return async (_client, options) => {
    const key = `${options.namespace}:${JSON.stringify(options.identity)}`;
    const cached = cache.get(key);
    if (cached && (!options.validate || options.validate(cached.payload))) return cached;
    const payload = await options.load({});
    if (options.validate && !options.validate(payload)) throw new Error('invalid payload');
    const result = { payload, completedAt: '2026-09-01T00:00:00Z' };
    cache.set(key, result);
    return result;
  };
}
const node = { node_address: 'thor1node', status: 'Active', active_block_height: 80, status_since: 80,
  total_bond: '1000', current_award: '100', bond_providers: { node_operator_fee: '0', providers: [] } };

function rpcResponse(params) {
  const writer = BinaryWriter.create();
  if (params.path.includes('/Node"')) {
    const reader = new BinaryReader(Buffer.from(params.data.slice(2), 'hex'));
    assert.equal(reader.uint32(), 10);
    writer.uint32(10).string(reader.string()).uint32(18).string(node.status)
      .uint32(48).int64(BigInt(node.active_block_height)).uint32(56).int64(BigInt(node.status_since))
      .uint32(74).string(node.total_bond).uint32(82).bytes(BinaryWriter.create().uint32(10).string('0').finish())
      .uint32(154).string(node.current_award);
  } else writer.uint32(106).string('100000000');
  return { result: { response: { code: 0, height: params.height, value: Buffer.from(writer.finish()).toString('base64') } } };
}

test('Bond raw historical node and network observations are shared across consumers', async () => {
  let requests = 0;
  const options = { acquireCached: memoryAcquisition(), fetchThorchainRpc: async (_path, params) => {
    requests++;
    return rpcResponse(params);
  } };
  for (let consumer = 0; consumer < 2; consumer++) {
    await fetchNodeAtHeight('thor1node', 99, options);
    await fetchNetworkAtHeight(100, options);
  }
  assert.equal(requests, 2);
});

test('Bond historical acquisition bypasses unverified v1 cache entries and persists height evidence', async () => {
  const cache = new Map([
    ['thorchain-mainnet:historical-node:v1:{"address":"thor1node","height":99}', { payload: node }],
    ['thorchain-mainnet:historical-network:v1:"100"', { payload: { rune_price_in_tor: '1' } }]
  ]);
  let reads = 0;
  const options = { acquireCached: memoryAcquisition(cache), fetchThorchainRpc: async (_path, params) => {
    reads++;
    return rpcResponse(params);
  } };
  assert.deepEqual(await fetchNodeAtHeight('thor1node', 99, options), node);
  assert.deepEqual(await fetchNetworkAtHeight(100, options), { rune_price_in_tor: '100000000' });
  assert.equal(reads, 2);
  assert.equal(cache.get('thorchain-mainnet:historical-node:v2:{"address":"thor1node","height":99}').payload.height, 99);
  assert.equal(cache.get('thorchain-mainnet:historical-network:v2:"100"').payload.height, 100);
});

test('Bond proven empty churns are durable only for the exact node set', async () => {
  const completed = new Map();
  let reads = 0;
  const options = {
    loadAcquisition: async (_client, namespace, identity) => completed.get(`${namespace}:${identity}`),
    saveAcquisition: async (_client, row) => completed.set(`${row.namespace}:${row.identity}`, row),
    acquireCached: async (_client, acquisition) => ({ payload: await acquisition.load({}) }),
    fetchThorchainRpc: async (_path, params) => { reads++; return rpcResponse(params); }
  };
  await processChurn('thor1bond', ['thor1node'], 100, 10, null, options);
  await processChurn('thor1bond', ['thor1node'], 100, 10, null, options);
  assert.equal(reads, 2);
  await processChurn('thor1bond', ['thor1other'], 100, 10, null, options);
  assert.equal(reads, 4);
});

test('Bond empty churn proof bypasses v1 and rejects absent or wrong height evidence', async () => {
  const row = { churn_height: 100, churn_timestamp: 10, rune_stack: 0, user_bond: 0, rune_price: 1 };
  for (const proof of [row, { row, node_height: 100, network_height: 100, nodes: ['thor1node'] },
    { row, node_height: 99, network_height: 100, nodes: ['thor1other'] }]) {
    let reads = 0;
    let saved;
    const options = {
      loadAcquisition: async (_client, namespace) => {
        assert.equal(namespace, 'bond-history:empty-churn:v2');
        return { completedAt: '2026-09-01T00:00:00Z', payload: proof };
      },
      saveAcquisition: async (_client, value) => { saved = value; },
      acquireCached: memoryAcquisition(),
      fetchThorchainRpc: async (_path, params) => { reads++; return rpcResponse(params); }
    };
    assert.equal((await processChurn('thor1bond', ['thor1node'], 100, 10, null, options)).rune_stack, 0);
    assert.equal(reads, 2);
    assert.deepEqual(saved.payload, { row: { ...row, rates_json: null }, node_height: 99,
      network_height: 100, nodes: ['thor1node'] });
  }
});

test('Bond height mismatch cannot be recorded as an empty churn', async () => {
  let saved = 0;
  const result = await processChurn('thor1bond', ['thor1node'], 100, 10, null, {
    loadAcquisition: async () => null, saveAcquisition: async () => { saved++; },
    acquireCached: memoryAcquisition(),
    fetchThorchainRpc: async (_path, params) => {
      const payload = rpcResponse(params);
      if (params.path.includes('/Node"')) payload.result.response.height = '110';
      return payload;
    }
  });
  assert.equal(result, null);
  assert.equal(saved, 0);
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
    fetchThorchainRpc: async (_path, params) => {
      if (params.path.includes('/Node"')) throw new Error('Request failed (404)');
      return rpcResponse(params);
    }
  });
  assert.equal(result, null);
  assert.equal(saved, 0);
});
