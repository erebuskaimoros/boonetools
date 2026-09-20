import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNodeAtHeight, fetchNetworkAtHeight } from '../src/shared/bond-history-acquisition.js';

const currentNode = {
  node_address: 'thor1node', status_since: 110, current_award: '100',
  bond_providers: { node_operator_fee: '0', providers: [] }
};

// Reproduces a historical request receiving valid-looking current state.
// A successful HTTP response must not make that state immutable history.
const ignoredHeight = {
  acquireCached: async (_client, acquisition) => ({ payload: await acquisition.load({}) }),
  fetchThorchain: async (url) => url.includes('/node/') ? currentNode : { rune_price_in_tor: '100000000' },
  fetchThorchainRpc: async () => ({ result: { response: { code: 0, height: '110', value: 'CgEx' } } })
};

test('historical bond node acquisition rejects state returned at a different height', async () => {
  await assert.rejects(fetchNodeAtHeight('thor1node', 99, ignoredHeight), /height|historical/i);
});

test('historical bond network acquisition rejects state returned at a different height', async () => {
  await assert.rejects(fetchNetworkAtHeight(99, ignoredHeight), /height|historical/i);
});
