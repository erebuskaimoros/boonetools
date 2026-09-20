import test from 'node:test';
import assert from 'node:assert/strict';
import { BinaryReader, BinaryWriter } from 'cosmjs-types/binary.js';
import {
  fetchHistoricalBondNode, fetchHistoricalBondNetwork, validHistoricalNode, validHistoricalNetwork
} from '../src/shared/bond-history-rpc.js';

const node = {
  node_address: 'thor1node', status: 'Active', active_block_height: 80, status_since: 80,
  total_bond: '9007199254740993', current_award: '100',
  bond_providers: { node_operator_fee: '1000', providers: [{ bond_address: 'thor1bond', bond: '9007199254740993' }] }
};

function encodeNode(overrides = {}) {
  const data = { ...node, ...overrides };
  const writer = BinaryWriter.create();
  for (const [field, key] of [[1, 'node_address'], [2, 'status'], [9, 'total_bond'], [19, 'current_award']]) {
    if (data[key] !== undefined) writer.uint32(field * 8 + 2).string(data[key]);
  }
  for (const [field, key] of [[6, 'active_block_height'], [7, 'status_since']]) {
    if (data[key] !== undefined) writer.uint32(field * 8).int64(BigInt(data[key]));
  }
  if (data.bond_providers !== undefined) {
    const providers = BinaryWriter.create();
    if (data.bond_providers.node_operator_fee !== undefined) providers.uint32(10).string(data.bond_providers.node_operator_fee);
    for (const provider of data.bond_providers.providers || []) {
      const item = BinaryWriter.create();
      if (provider.bond_address !== undefined) item.uint32(10).string(provider.bond_address);
      if (provider.bond !== undefined) item.uint32(18).string(provider.bond);
      providers.uint32(18).bytes(item.finish());
    }
    writer.uint32(82).bytes(providers.finish());
  }
  // Unrelated future fields do not change interpretation of the stable fields.
  writer.uint32(800).uint32(1);
  return writer.finish();
}

function response(bytes, overrides = {}) {
  return { result: { response: { code: 0, height: '99', value: Buffer.from(bytes).toString('base64'), ...overrides } } };
}

test('historical Node RPC encodes the address and retains verified height and exact numeric strings', async () => {
  const client = {};
  const result = await fetchHistoricalBondNode('thor1node', 99, { client, rpcUrls: ['https://rpc.example'],
    fetchThorchainRpc: async (requestPath, params, options) => {
      assert.equal(requestPath, '/abci_query');
      assert.equal(params.path, '"/types.Query/Node"');
      assert.equal(params.height, '99');
      const request = new BinaryReader(Buffer.from(params.data.slice(2), 'hex'));
      assert.equal(request.uint32(), 10);
      assert.equal(request.string(), 'thor1node');
      assert.equal(request.pos, request.len);
      assert.equal(options.cooldownClient, client);
      assert.equal(options.sharedCooldown, true);
      assert.deepEqual(options.rpcUrls, ['https://rpc.example']);
      return response(encodeNode());
    }
  });
  assert.deepEqual(result, { height: 99, data: node });
});

test('historical Network RPC uses an empty query and verifies the RUNE price height', async () => {
  const result = await fetchHistoricalBondNetwork('99', { fetchThorchainRpc: async (_path, params) => {
    assert.equal(params.path, '"/types.Query/Network"');
    assert.equal(params.data, '0x');
    assert.equal(params.height, '99');
    return response(BinaryWriter.create().uint32(106).string('123456789').finish());
  } });
  assert.deepEqual(result, { height: 99, data: { rune_price_in_tor: '123456789' } });
});

test('historical node decoding honors omitted int64 zero defaults', async () => {
  const result = await fetchHistoricalBondNode('thor1node', 99, { fetchThorchainRpc: async () => response(encodeNode({
    status: 'Standby', active_block_height: undefined, status_since: undefined
  })) });
  assert.equal(result.data.active_block_height, 0);
  assert.equal(result.data.status_since, 0);
});

test('historical RPC rejects absent or different heights, errors, and malformed values', async () => {
  for (const overrides of [
    { height: '100' }, { height: undefined }, { height: null }, { height: '99.0' },
    { code: 1 }, { code: undefined }, { code: null }, { value: '' }, { value: 'not-base64' },
    { value: Buffer.from([10, 5, 65]).toString('base64') }
  ]) {
    const options = { fetchThorchainRpc: async () => response(encodeNode(), overrides) };
    await assert.rejects(fetchHistoricalBondNode('thor1node', 99, options), undefined, JSON.stringify(overrides));
    await assert.rejects(fetchHistoricalBondNetwork(99, options), undefined, JSON.stringify(overrides));
  }
});

test('historical node acquisition rejects mismatched addresses, newer state, and malformed monetary fields', async () => {
  for (const overrides of [
    { node_address: 'thor1other' }, { status: '' }, { status: undefined },
    { active_block_height: 100 }, { status_since: 100 }, { status_since: -1 },
    { active_block_height: '9007199254740993' }, { total_bond: undefined },
    { current_award: undefined }, { current_award: '-1' }, { current_award: 'NaN' },
    { bond_providers: undefined }, { bond_providers: { providers: [] } },
    { bond_providers: { node_operator_fee: '10001', providers: [] } },
    { bond_providers: { node_operator_fee: '0', providers: [{ bond: '1' }] } },
    { bond_providers: { node_operator_fee: '0', providers: [{ bond_address: 'thor1bond', bond: '-1' }] } },
    { bond_providers: { node_operator_fee: '0', providers: [node.bond_providers.providers[0], node.bond_providers.providers[0]] } }
  ]) {
    await assert.rejects(fetchHistoricalBondNode('thor1node', 99, {
      fetchThorchainRpc: async () => response(encodeNode(overrides))
    }), /Invalid historical node state/, JSON.stringify(overrides));
  }
});

test('historical Network rejects absent and malformed price fields', async () => {
  for (const value of ['', '-1', 'NaN', '1.5']) {
    await assert.rejects(fetchHistoricalBondNetwork(99, {
      fetchThorchainRpc: async () => response(BinaryWriter.create().uint32(106).string(value).finish())
    }), /Invalid historical network state/);
  }
  await assert.rejects(fetchHistoricalBondNetwork(99, {
    fetchThorchainRpc: async () => response(BinaryWriter.create().uint32(10).string('1').finish())
  }), /Invalid historical network state/);
});

test('cache validation requires exact persisted height evidence', () => {
  assert.equal(validHistoricalNode({ height: 99, data: node }, 'thor1node', 99), true);
  assert.equal(validHistoricalNode(node, 'thor1node', 99), false);
  assert.equal(validHistoricalNode({ data: node }, 'thor1node', 99), false);
  assert.equal(validHistoricalNode({ height: 100, data: node }, 'thor1node', 99), false);
  const network = { rune_price_in_tor: '100000000' };
  assert.equal(validHistoricalNetwork({ height: 99, data: network }, 99), true);
  assert.equal(validHistoricalNetwork(network, 99), false);
  assert.equal(validHistoricalNetwork({ height: 100, data: network }, 99), false);
});

test('invalid requested heights fail before making requests', async () => {
  let requests = 0;
  const options = { fetchThorchainRpc: async () => { requests++; } };
  for (const height of [0, -1, 1.5, NaN, Infinity, true, null, '', '1e2', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fetchHistoricalBondNode('thor1node', height, options), /Invalid historical bond height/);
    await assert.rejects(fetchHistoricalBondNetwork(height, options), /Invalid historical bond height/);
  }
  assert.equal(requests, 0);
});
