import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithFallback, fetchJSONWithFallback, THORNODE_ENDPOINTS } from '../src/lib/utils/api.js';
import { fetchThorchain as fetchRapidSwapThorchain } from '../shared/rapid-swaps/backend.js';
import { getCurrentBlock } from '../src/lib/utils/network.js';

const PRIMARY = 'https://gateway.liquify.com/chain/thorchain_api';
const FALLBACK = 'https://public-thornode.nativeswap.io';
const RPC_PRIMARY = 'https://gateway.liquify.com/chain/thorchain_rpc';
const RPC_FALLBACK = 'https://public-thorchain-rpc.nativeswap.io';

test('browser THORNode defaults remain Liquify first, NativeSwap second', () => {
  assert.deepEqual(THORNODE_ENDPOINTS, { primary: PRIMARY, fallback: FALLBACK });
});

test('healthy Liquify does not contact NativeSwap, and total failure is not swallowed', async () => {
  const calls = [];
  await fetchWithFallback('/thorchain/pools', { fetchImpl: async url => { calls.push(url); return Response.json([]); } });
  assert.deepEqual(calls, [`${PRIMARY}/thorchain/pools`]);
  calls.length = 0;
  await assert.rejects(fetchWithFallback('/thorchain/pools', { fetchImpl: async url => {
    calls.push(url); throw new TypeError('offline');
  } }), /offline/);
  assert.deepEqual(calls, [PRIMARY, FALLBACK].map(base => `${base}/thorchain/pools`));
});

test('browser JSON parsing failures advance to NativeSwap', async () => {
  const calls = [];
  const result = await fetchJSONWithFallback('/thorchain/pools?height=28274900', {
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
  const options = { blockHeight: 28274900, fetchImpl: async (url, request) => {
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

test('browser current block tries NativeSwap RPC before the THORNode read model', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    if (url.startsWith(RPC_PRIMARY)) return new Response('unavailable', { status: 503 });
    assert.equal(url, `${RPC_FALLBACK}/status`);
    return Response.json({ result: { sync_info: { latest_block_height: '28274900' } } });
  });
  assert.equal(await getCurrentBlock(), 28274900);
  assert.deepEqual(calls, [RPC_PRIMARY, RPC_FALLBACK].map(base => `${base}/status`));
});
