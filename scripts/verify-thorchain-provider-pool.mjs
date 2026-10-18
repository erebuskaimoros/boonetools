// Read-only, bounded live verification. The simulated failure lives only in
// this process; it never changes production configuration or SQL cooldowns.
import assert from 'node:assert/strict';
import { requestFromProviders } from '../shared/provider-client.js';
import { createThorchainProviderPool } from '../shared/thorchain-provider-pool.js';
import { THORNODE_PUBLIC_URLS, RPC_PUBLIC_URLS, LIQUIFY_THORNODE, LIQUIFY_RPC } from '../shared/thorchain-providers.js';

const providerPool = createThorchainProviderPool({ maxConcurrent: 2 });
const calls = [];
const fetchImpl = async (url, options) => {
  const entry = { provider: url.startsWith(LIQUIFY_THORNODE) || url.startsWith(LIQUIFY_RPC) ? 'Liquify' : 'NativeSwap',
    kind: options.method === 'POST' ? 'batch' : url.endsWith('/status') ? 'status' : 'api', start: Date.now() };
  calls.push(entry);
  try { const response = await fetch(url, options); entry.status = response.status; return response; }
  finally { entry.end = Date.now(); }
};
const request = options => requestFromProviders({ timeoutMs: 20_000, providerPool, fetchImpl, ...options });
const api = await Promise.all([0, 1].map(() => request({ bases: THORNODE_PUBLIC_URLS, path: '/thorchain/lastblock' })));
assert.ok(api.every(rows => Array.isArray(rows) && rows.some(row => Number(row.thorchain) > 0)));
const status = await request({ bases: RPC_PUBLIC_URLS, path: '/status' });
assert.equal(status.result.node_info.network, 'thorchain-1');
const height = Number(status.result.sync_info.latest_block_height) - 20;
const batches = await Promise.all([0, 2].map(offset => {
  const heights = [height - offset, height - offset - 1];
  return request({ bases: RPC_PUBLIC_URLS, path: '/',
    headers: { 'content-type': 'application/json' },
    request: { method: 'POST', body: JSON.stringify(heights.map(value => ({ jsonrpc: '2.0', id: String(value),
      method: 'block_results', params: { height: String(value) } }))) }
  }).then(payload => {
    assert.equal(payload.length, heights.length);
    for (const value of heights) assert.equal(Number(payload.find(row => row.id === String(value))?.result?.height), value);
    return heights;
  });
}));
const batchCalls = calls.filter(row => row.kind === 'batch');
assert.deepEqual(new Set(batchCalls.filter(row => row.status === 200).map(row => row.provider)), new Set(['Liquify', 'NativeSwap']));
assert.ok(batchCalls[0].start < batchCalls[1].end && batchCalls[1].start < batchCalls[0].end, 'both providers must overlap');

const failoverCalls = [];
const failover = await requestFromProviders({ bases: THORNODE_PUBLIC_URLS, path: '/thorchain/lastblock', timeoutMs: 20_000,
  providerPool: createThorchainProviderPool(), fetchImpl: (url, options) => {
    failoverCalls.push(url.startsWith(LIQUIFY_THORNODE) ? 'Liquify (simulated 503)' : 'NativeSwap');
    return url.startsWith(LIQUIFY_THORNODE) ? Promise.resolve(new Response('simulated failure', { status: 503 })) : fetch(url, options);
  } });
assert.ok(Array.isArray(failover));
assert.equal(failoverCalls.length, 2);
console.log(JSON.stringify({ verified: true, apiReads: api.length, blockResults: batches.flat().length,
  overlappingProviders: true, calls: calls.map(({ start, end, ...row }) => ({ ...row, elapsedMs: end - start })),
  isolatedFailover: failoverCalls }, null, 2));
