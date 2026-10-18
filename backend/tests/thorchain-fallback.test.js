import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { config } from '../src/lib/config.js';
import { fetchThorchain } from '../src/shared/thornode.js';
import { fetchThorchainRpc } from '../src/shared/rpc.js';
import { createFinancialsProviderRequest } from '../src/jobs/financials.js';
import { fetchFinancialRewardBlockBatch } from '../src/shared/financials-reward-source.js';

const API_PRIMARY = 'https://gateway.liquify.com/chain/thorchain_api';
const API_FALLBACK = 'https://public-thornode.nativeswap.io';
const RPC_PRIMARY = 'https://gateway.liquify.com/chain/thorchain_rpc';
const RPC_FALLBACK = 'https://public-thorchain-rpc.nativeswap.io';

test('backend current and historical provider defaults include NativeSwap after Liquify', () => {
  assert.deepEqual(config.thornodeUrls, [API_PRIMARY, API_FALLBACK]);
  assert.deepEqual(config.rpcRestUrls, [RPC_PRIMARY, RPC_FALLBACK]);
  assert.deepEqual(config.poolDislocationThornodeUrls, [API_PRIMARY, API_FALLBACK]);
  assert.ok(config.polTrackerThornodeUrls.includes(API_FALLBACK));
  assert.ok(config.polTrackerRpcUrls.includes(RPC_FALLBACK));
  assert.deepEqual(config.rujiraBaseFeesRpcUrls, [RPC_PRIMARY, RPC_FALLBACK]);
  assert.deepEqual(config.rujiraReservePaymentsRpcUrls, [RPC_PRIMARY, RPC_FALLBACK]);
  assert.ok(config.nodeVotesRpcUrls.includes(RPC_FALLBACK));
  assert.deepEqual(config.rpcWsUrls, ['wss://gateway.liquify.com/chain/thorchain_rpc/websocket']);
});

test('explicit operator provider lists remain authoritative', () => {
  const source = `import { config } from ${JSON.stringify(new URL('../src/lib/config.js', import.meta.url).href)};
    console.log(JSON.stringify([config.thornodeUrls, config.rpcRestUrls, config.poolDislocationThornodeUrls, config.polTrackerRpcUrls]));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8',
    env: { ...process.env, THORNODE_URLS: 'https://custom-api.example', RPC_REST_URLS: 'https://custom-rpc.example',
      POOL_DISLOCATION_THORNODE_URLS: 'https://pool.example', POL_TRACKER_RPC_URLS: 'https://history.example' } });
  assert.deepEqual(JSON.parse(output.trim()), [['https://custom-api.example'], ['https://custom-rpc.example'], ['https://pool.example'], ['https://history.example']]);
});

test('the backend balancing switch restores ordered provider selection', () => {
  const source = `import { fetchThorchain } from ${JSON.stringify(new URL('../src/shared/thornode.js', import.meta.url).href)};
    const calls = [];
    globalThis.fetch = async url => { calls.push(url); return Response.json({ ok: true }); };
    await fetchThorchain('/thorchain/network', { sharedCooldown: false });
    await fetchThorchain('/thorchain/network', { sharedCooldown: false });
    console.log(JSON.stringify(calls));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8',
    env: { ...process.env, THORCHAIN_PROVIDER_BALANCING_ENABLED: 'false' } });
  assert.deepEqual(JSON.parse(output.trim()), Array(2).fill(`${API_PRIMARY}/thorchain/network`));
});

test('a Liquify cooldown skips it without blocking NativeSwap HTTP reads', async (t) => {
  const calls = [];
  const cooldownClient = { query: async (sql, params) => ({ rows:
    sql.includes('where provider_key') && params[0].includes('global:gateway.liquify.com')
      ? [{ provider_key: 'global:gateway.liquify.com', blocked_until: '2099-01-01T00:00:00Z', last_error: 'rate limited' }]
      : [] }) };
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return Response.json({ ok: true }); });
  const options = { sharedCooldown: true, cooldownClient };
  await fetchThorchain('/thorchain/network', options);
  await fetchThorchainRpc('/status', {}, options);
  assert.deepEqual(calls, [`${API_FALLBACK}/thorchain/network`, `${RPC_FALLBACK}/status`]);
});

for (const failure of ['network', '429', '503', 'invalid-json']) {
  test(`backend THORNode and RPC fail over after ${failure} with queries intact`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(url);
      if (url.startsWith(API_PRIMARY) || url.startsWith(RPC_PRIMARY)) {
        if (failure === 'network') throw new TypeError('fetch failed');
        if (failure === 'invalid-json') return new Response('not JSON');
        return new Response('unavailable', { status: Number(failure) });
      }
      return Response.json({ ok: true });
    });
    assert.deepEqual(await fetchThorchain('/thorchain/network?height=28274900', { sharedCooldown: false }), { ok: true });
    assert.deepEqual(await fetchThorchainRpc('/block', { height: 28274900 }, { sharedCooldown: false, providerMode: 'fallback' }), { ok: true });
    assert.deepEqual(calls, [
      `${API_PRIMARY}/thorchain/network?height=28274900`, `${API_FALLBACK}/thorchain/network?height=28274900`,
      `${RPC_PRIMARY}/block?height=28274900`, `${RPC_FALLBACK}/block?height=28274900`
    ]);
  });
}

test('Financials historical RPC and reward batch use configured fallback lists', async () => {
  const requests = [];
  const transport = async (request) => { requests.push(request); return {}; };
  const get = createFinancialsProviderRequest({}, { transport });
  await get(`${RPC_PRIMARY}/abci_query?height=28274900`);
  await fetchFinancialRewardBlockBatch({}, [28274900], { transport });
  for (const request of requests) assert.deepEqual(request.bases, [RPC_PRIMARY, RPC_FALLBACK]);
  await get('https://gateway.liquify.com/chain/thorchain_midgard/v2/health');
  assert.deepEqual(requests.at(-1).bases, ['https://gateway.liquify.com/chain/thorchain_midgard/v2']);
});

test('a single-item NativeSwap reward batch is normalized only for its requested ID', async () => {
  const result = { jsonrpc: '2.0', id: '28274900', result: { height: '28274900', finalize_block_events: [] } };
  assert.deepEqual(await fetchFinancialRewardBlockBatch({}, [28274900], { transport: async () => result }), [result]);
  assert.deepEqual(await fetchFinancialRewardBlockBatch({}, [28274901], { transport: async () => result }), result);
});

