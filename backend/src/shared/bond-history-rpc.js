import { BinaryReader, BinaryWriter } from 'cosmjs-types/binary.js';
import { config } from '../lib/config.js';
import { fetchThorchainRpc } from './rpc.js';

export function historicalBondHeight(value) {
  const height = Number(value);
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))
    || !Number.isSafeInteger(height) || height <= 0) throw new Error('Invalid historical bond height');
  return height;
}

function unsigned(value) {
  return typeof value === 'string' && /^\d+$/.test(value) && Number.isFinite(Number(value));
}

function stateHeight(value, height) {
  return Number.isSafeInteger(value) && value >= 0 && value <= height;
}

export function validHistoricalNode(observation, address, height) {
  const node = observation?.data;
  const providers = node?.bond_providers?.providers;
  return observation?.height === height && node?.node_address === address
    && typeof node?.status === 'string' && node.status.length > 0
    && stateHeight(node.active_block_height, height) && stateHeight(node.status_since, height)
    && unsigned(node.total_bond) && unsigned(node.current_award)
    && unsigned(node.bond_providers?.node_operator_fee) && Number(node.bond_providers.node_operator_fee) <= 10000
    && Array.isArray(providers) && providers.every((provider) => typeof provider?.bond_address === 'string'
      && provider.bond_address.length > 0 && unsigned(provider.bond))
    && new Set(providers.map((provider) => provider.bond_address)).size === providers.length;
}

export function validHistoricalNetwork(observation, height) {
  return observation?.height === height && unsigned(observation?.data?.rune_price_in_tor);
}

// Decode the stable fields needed by the bond tracker, using field numbers from
// ThorNode's proto/thorchain/v1/types/query_{node,network}.proto. Numeric strings
// must be present; omitted protobuf int64 fields legitimately represent zero.
function readFields(bytes, fields) {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();
    const handler = fields[field];
    if (handler) {
      if (wireType !== handler[0]) throw new Error('Malformed historical protobuf field');
      handler[1](reader);
    } else reader.skipType(wireType);
    reader.assertBounds();
  }
}

function decodeProvider(bytes) {
  const provider = {};
  readFields(bytes, {
    1: [2, (reader) => { provider.bond_address = reader.string(); }],
    2: [2, (reader) => { provider.bond = reader.string(); }]
  });
  return provider;
}

function decodeProviders(bytes) {
  const providers = { providers: [] };
  readFields(bytes, {
    1: [2, (reader) => { providers.node_operator_fee = reader.string(); }],
    2: [2, (reader) => { providers.providers.push(decodeProvider(reader.bytes())); }]
  });
  return providers;
}

function decodeNode(bytes) {
  const node = { active_block_height: 0, status_since: 0 };
  readFields(bytes, {
    1: [2, (reader) => { node.node_address = reader.string(); }],
    2: [2, (reader) => { node.status = reader.string(); }],
    6: [0, (reader) => { node.active_block_height = Number(reader.int64()); }],
    7: [0, (reader) => { node.status_since = Number(reader.int64()); }],
    9: [2, (reader) => { node.total_bond = reader.string(); }],
    10: [2, (reader) => { node.bond_providers = decodeProviders(reader.bytes()); }],
    19: [2, (reader) => { node.current_award = reader.string(); }]
  });
  return node;
}

function decodeNetwork(bytes) {
  const network = {};
  readFields(bytes, { 13: [2, (reader) => { network.rune_price_in_tor = reader.string(); }] });
  return network;
}

async function queryAtHeight(method, request, height, options) {
  const payload = await (options.fetchThorchainRpc || fetchThorchainRpc)('/abci_query', {
    path: `"/types.Query/${method}"`, data: `0x${Buffer.from(request).toString('hex')}`, height: String(height)
  }, {
    rpcUrls: options.rpcUrls || [...new Set([...config.rpcRestUrls, config.rpcArchiveRestUrl].filter(Boolean))],
    cooldownClient: options.client, sharedCooldown: true
  });
  const response = payload?.result?.response;
  if ((response?.code !== 0 && response?.code !== '0') || typeof response?.value !== 'string' || !response.value) {
    throw new Error(response?.log || payload?.error?.message || 'Historical bond RPC state is unavailable');
  }
  if (!/^\d+$/.test(String(response.height ?? '')) || Number(response.height) !== height) {
    throw new Error('RPC did not return the requested historical bond height');
  }
  const bytes = Buffer.from(response.value, 'base64');
  if (bytes.toString('base64') !== response.value) throw new Error('Malformed historical bond RPC value');
  return bytes;
}

export async function fetchHistoricalBondNode(nodeAddress, requestedHeight, options = {}) {
  const height = historicalBondHeight(requestedHeight);
  if (typeof nodeAddress !== 'string' || !nodeAddress) throw new Error('Invalid historical node address');
  const request = BinaryWriter.create().uint32(10).string(nodeAddress).finish();
  const bytes = await queryAtHeight('Node', request, height, options);
  const observation = { height, data: decodeNode(bytes) };
  if (!validHistoricalNode(observation, nodeAddress, height)) throw new Error('Invalid historical node state');
  return observation;
}

export async function fetchHistoricalBondNetwork(requestedHeight, options = {}) {
  const height = historicalBondHeight(requestedHeight);
  const bytes = await queryAtHeight('Network', new Uint8Array(), height, options);
  const observation = { height, data: decodeNetwork(bytes) };
  if (!validHistoricalNetwork(observation, height)) throw new Error('Invalid historical network state');
  return observation;
}
