import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithFallback, fetchJSONWithFallback, THORNODE_ENDPOINTS } from '../src/lib/utils/api.js';
import { fetchThorchain as fetchRapidSwapThorchain } from '../shared/rapid-swaps/backend.js';
import { getCurrentBlock } from '../src/lib/utils/network.js';
import { createThorchainProviderPool } from '../shared/thorchain-provider-pool.js';

const PRIMARY = 'https://gateway.liquify.com/chain/thorchain_api';
const FALLBACK = 'https://public-thornode.nativeswap.io';
const RPC_PRIMARY = 'https://gateway.liquify.com/chain/thorchain_rpc';
const RPC_FALLBACK = 'https://public-thorchain-rpc.nativeswap.io';

test('browser THORNode defaults remain Liquify first, NativeSwap second', () => {
  assert.deepEqual(THORNODE_ENDPOINTS, { primary: PRIMARY, fallback: FALLBACK });
});

test('healthy reads alternate providers without duplication, and total failure is not swallowed', async () => {
  const calls = [];
  const providerPool = createThorchainProviderPool();
  await fetchWithFallback('/thorchain/pools', { providerPool, fetchImpl: async url => { calls.push(url); return Response.json([]); } });
  assert.deepEqual(calls, [`${PRIMARY}/thorchain/pools`]);
  calls.length = 0;
  await assert.rejects(fetchWithFallback('/thorchain/pools', { providerPool, fetchImpl: async url => {
    calls.push(url); throw new TypeError('offline');
  } }), /offline/);
  assert.deepEqual(calls, [FALLBACK, PRIMARY].map(base => `${base}/thorchain/pools`));
});

test('browser JSON parsing failures advance to NativeSwap', async () => {
  const calls = [];
  const result = await fetchJSONWithFallback('/thorchain/pools?height=28274900', {
    providerPool: createThorchainProviderPool(),
    fetchImpl: async url => {
      calls.push(url);
      return url.startsWith(PRIMARY) ? new Response('invalid JSON') : Response.json([]);
    }
  });
  assert.deepEqual(result, []);
  assert.deepEqual(calls, [PRIMARY, FALLBACK].map(base => `${base}/thorchain/pools?height=28274900`));
});

for (const failure of ['network', 'timeout', '429', '503', 'challenge']) {
  test(`browser THORNode fails over after ${failure} without NativeSwap CORS preflight`, async () => {
    const calls = [];
    const response = await fetchWithFallback('/thorchain/pools?height=28274900', {
      providerPool: createThorchainProviderPool(),
      timeoutMs: 5,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.startsWith(PRIMARY)) {
          if (failure === 'network') throw new TypeError('fetch failed');
          if (failure === 'timeout') return new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
          });
          if (failure === 'challenge') return new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
          return new Response('unavailable', { status: Number(failure) });
        }
        return Response.json([{ asset: 'BTC.BTC' }]);
      }
    });
    assert.deepEqual(await response.json(), [{ asset: 'BTC.BTC' }]);
    assert.deepEqual(calls.map(call => call.url), [PRIMARY, FALLBACK].map(base => `${base}/thorchain/pools?height=28274900`));
    assert.equal(calls[0].options.headers['x-client-id'], 'BooneTools');
    assert.equal(calls[1].options.headers['x-client-id'], undefined);
  });
}

test('THORNode class uses the fallback on rate limits and retains height and cache behavior', async () => {
  const { ThorNodeClient } = await import('../src/lib/api/thornode.js');
  const client = new ThorNodeClient();
  const calls = [];
  const options = { providerPool: createThorchainProviderPool(), blockHeight: 28274900, fetchImpl: async (url, request) => {
    calls.push(url);
    if (url.startsWith(PRIMARY)) return new Response('rate limited', { status: 429 });
    assert.equal(request.headers['x-client-id'], undefined);
    return Response.json({ ok: true });
  } };
  assert.deepEqual(await client.fetch('/thorchain/network', options), { ok: true });
  assert.deepEqual(await client.fetch('/thorchain/network', options), { ok: true });
  assert.deepEqual(calls, [PRIMARY, FALLBACK].map(base => `${base}/thorchain/network?height=28274900`));
});

test('Rapid Swaps THORNode rate limits fail over without changing Midgard policy', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return url.startsWith(PRIMARY) ? new Response('rate limited', { status: 429 }) : Response.json({ ok: true });
  });
  assert.deepEqual(await fetchRapidSwapThorchain('/thorchain/tx/test'), { ok: true });
  assert.deepEqual(calls, [PRIMARY, FALLBACK].map(base => `${base}/thorchain/tx/test`));
});

test('browser current block respects the shared Liquify 429 cooldown and uses NativeSwap RPC', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    if (url.startsWith(RPC_PRIMARY)) return new Response('unavailable', { status: 503 });
    assert.equal(url, `${RPC_FALLBACK}/status`);
    return Response.json({ result: { sync_info: { latest_block_height: '28274900' } } });
  });
  assert.equal(await getCurrentBlock(), 28274900);
  assert.deepEqual(calls, [`${RPC_FALLBACK}/status`]);
});

test('development Financials shares the RPC provider pool without changing Midgard', async () => {
  const { createFinancialsDevRequest } = await import('../scripts/dev-financials.mjs');
  const calls = [];
  const get = createFinancialsDevRequest(async options => { calls.push(options); return {}; });
  await get('/abci_query?height=150', { service: 'rpc' });
  await get('/health');
  assert.deepEqual(calls[0].bases, [RPC_PRIMARY, RPC_FALLBACK]);
  assert.equal(calls[0].providerMinIntervalMs, 650);
  assert.deepEqual(calls[1].bases, ['https://gateway.liquify.com/chain/thorchain_midgard/v2']);
  assert.throws(() => get('https://unrelated.example/health'), /service base/);
});
