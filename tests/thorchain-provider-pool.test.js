import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { requestFromProviders } from '../shared/provider-client.js';
import { createThorchainProviderPool } from '../shared/thorchain-provider-pool.js';
import { LIQUIFY_THORNODE, NATIVESWAP_THORNODE, LIQUIFY_RPC, NATIVESWAP_RPC } from '../shared/thorchain-providers.js';

const API = [LIQUIFY_THORNODE, NATIVESWAP_THORNODE];
const RPC = [LIQUIFY_RPC, NATIVESWAP_RPC];
const NOW = Date.parse('2026-10-18T01:00:00Z');
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers }
});
const head = (earliest = 100, latest = 200) => ({ result: {
  node_info: { network: 'thorchain-1' },
  sync_info: { earliest_block_height: String(earliest), latest_block_height: String(latest),
    latest_block_time: new Date(NOW).toISOString(), catching_up: false }
} });
const pool = (options = {}) => createThorchainProviderPool({ now: () => NOW, maxConcurrent: 2, ...options });

test('eligible calls occupy both provider lanes concurrently, with a bounded queue per provider', async () => {
  const providerPool = pool();
  const active = new Map(), peaks = new Map(), calls = [], release = [];
  const fetchImpl = async (url) => {
    const base = API.find((base) => url.startsWith(base));
    calls.push(base);
    active.set(base, (active.get(base) || 0) + 1);
    peaks.set(base, Math.max(peaks.get(base) || 0, active.get(base)));
    await new Promise((resolve) => release.push(resolve));
    active.set(base, active.get(base) - 1);
    return json({ base });
  };
  const requests = Array.from({ length: 8 }, (_, i) => requestFromProviders({
    bases: API, path: `/thorchain/pool/asset${i}`, fetchImpl, providerPool
  }));
  await tick();
  assert.equal(calls.length, 4, 'two requests on each provider, not eight on the primary');
  assert.deepEqual(calls, [LIQUIFY_THORNODE, NATIVESWAP_THORNODE, LIQUIFY_THORNODE, NATIVESWAP_THORNODE]);
  release.splice(0).forEach((resolve) => resolve());
  await tick();
  assert.equal(calls.length, 8);
  release.splice(0).forEach((resolve) => resolve());
  const results = await Promise.all(requests);
  assert.equal(results.filter((row) => row.base === LIQUIFY_THORNODE).length, 4);
  assert.deepEqual([...peaks.values()], [2, 2]);
});

test('a throttled provider fails over and queued calls recheck its cooldown before sending', async () => {
  const providerPool = pool({ maxConcurrent: 1 });
  const calls = [];
  let release;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith(LIQUIFY_THORNODE)) {
      await new Promise((resolve) => { release = resolve; });
      return json({ error: 'too many requests' }, 429, { 'retry-after': '120' });
    }
    return json({ ok: true });
  };
  const requests = Array.from({ length: 6 }, (_, i) => requestFromProviders({
    bases: API, path: `/thorchain/pool/asset${i}`, fetchImpl, providerPool
  }));
  await tick();
  release();
  assert.ok((await Promise.all(requests)).every((result) => result.ok));
  assert.equal(calls.filter((url) => url.startsWith(LIQUIFY_THORNODE)).length, 1);
  assert.equal(calls.filter((url) => url.startsWith(NATIVESWAP_THORNODE)).length, 6);
});

test('cooldowns expire and one provider can recover without resetting its peer', async () => {
  let now = NOW;
  const providerPool = pool({ now: () => now });
  const calls = [];
  let failed = false;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!failed && url.startsWith(LIQUIFY_THORNODE)) {
      failed = true;
      return json({}, 503, { 'retry-after': new Date(NOW + 120_000).toUTCString() });
    }
    return json({ ok: true });
  };
  const run = () => requestFromProviders({ bases: API, path: '/thorchain/pools', fetchImpl, providerPool });
  await run();
  now += 61_000;
  await run(); await run();
  assert.equal(calls.filter((url) => url.startsWith(LIQUIFY_THORNODE)).length, 1);
  now += 60_000;
  await run(); await run();
  assert.equal(calls.filter((url) => url.startsWith(LIQUIFY_THORNODE)).length, 2);
});

test('canceling queued work neither sends it nor leaks its provider slot or opens a breaker', async () => {
  const providerPool = pool({ maxConcurrent: 1 });
  const calls = [], release = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    await new Promise((resolve) => release.push(resolve));
    return json({ ok: true });
  };
  const run = (id, signal) => requestFromProviders({ bases: API, path: `/thorchain/pool/${id}`,
    fetchImpl, providerPool, request: { signal } });
  const first = run('one'), second = run('two');
  await tick();
  const controller = new AbortController();
  const canceled = assert.rejects(run('cancel', controller.signal), { name: 'AbortError' });
  controller.abort();
  await canceled;
  const last = run('last');
  release.splice(0).forEach((resolve) => resolve());
  await tick();
  release.splice(0).forEach((resolve) => resolve());
  await Promise.all([first, second, last]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => !url.endsWith('/cancel')));
});

test('recent RPC batches run on both providers and coalesce the NativeSwap retention probe', async () => {
  const providerPool = pool();
  const calls = [], release = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/status')) return json(head());
    const body = JSON.parse(options.body);
    await new Promise((resolve) => release.push(resolve));
    return json(body.map((entry) => ({ id: entry.id, result: { height: entry.params.height } })));
  };
  const run = (height) => requestFromProviders({ bases: RPC, path: '/', fetchImpl, providerPool,
    request: { method: 'POST', body: JSON.stringify([{ id: String(height), jsonrpc: '2.0',
      method: 'block_results', params: { height: String(height) } }]) } });
  const requests = [run(150), run(151)];
  await tick();
  assert.deepEqual(calls, [`${NATIVESWAP_RPC}/status`, `${LIQUIFY_RPC}/`, `${NATIVESWAP_RPC}/`]);
  release.splice(0).forEach((resolve) => resolve());
  await Promise.all(requests);
});

test('old RPC ranges and unbounded searches stay off NativeSwap; supported bounded searches are balanced', async () => {
  const providerPool = pool();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return json(url.endsWith('/status') ? head() : { result: { total_count: '0', txs: [] } });
  };
  for (const path of ['/block?height=50', '/blockchain?minHeight=50&maxHeight=150',
    '/tx_search?query=%22tx.height%3C%3D150%22', '/abci_query?height=50&path=%22/store/bank/key%22',
    '/tx_search?query=' + encodeURIComponent("memo.value='tx.height>=110'"),
    '/tx_search?query=' + encodeURIComponent('tx.height>=110 OR tx.height<100')]) {
    await requestFromProviders({ bases: RPC, path, fetchImpl, providerPool });
  }
  assert.equal(calls.filter((url) => url.startsWith(NATIVESWAP_RPC) && !url.endsWith('/status')).length, 0);
  const path = '/tx_search?query=' + encodeURIComponent('"tx.height>=110 AND tx.height<=150"');
  await requestFromProviders({ bases: RPC, path, fetchImpl, providerPool });
  await requestFromProviders({ bases: RPC, path, fetchImpl, providerPool });
  assert.ok(calls.at(-1).startsWith(NATIVESWAP_RPC));
});

test('a gateway quota affects its API and RPC, while dedicated credentials have a separate budget', async () => {
  const providerPool = pool();
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return url.startsWith(LIQUIFY_THORNODE) ? json({}, 429) : json({ result: {} });
  };
  await requestFromProviders({ bases: API, path: '/thorchain/pools', providerPool, fetchImpl });
  await requestFromProviders({ bases: RPC, path: '/status', providerPool, fetchImpl });
  assert.ok(!calls.includes(`${LIQUIFY_RPC}/status`));
  const dedicated = 'https://gateway.liquify.com/api=private-test-key';
  await requestFromProviders({ bases: [dedicated], path: '/status', providerPool, fetchImpl });
  assert.equal(calls.at(-1), `${dedicated}/status`);
});

test('the public API and RPC share one process-local gateway concurrency ceiling', async () => {
  const providerPool = pool({ maxConcurrent: 1 });
  const calls = [], gates = [];
  const fetchImpl = async url => {
    calls.push(url); await new Promise(resolve => gates.push(resolve)); return json({ result: {} });
  };
  const api = requestFromProviders({ bases: [LIQUIFY_THORNODE], path: '/thorchain/pools', providerPool, fetchImpl });
  const rpc = requestFromProviders({ bases: [LIQUIFY_RPC], path: '/status', providerPool, fetchImpl });
  await tick(); assert.equal(calls.length, 1);
  gates[0](); await tick(); assert.equal(calls.length, 2);
  gates[1](); await Promise.all([api, rpc]);
});

test('mixed RPC batches preserve valid results for per-height persistence', async () => {
  const providerPool = pool();
  const result = [{ id: '150', result: { height: '150' } }, { id: '151', error: { message: 'height unavailable' } }];
  const calls = [];
  const payload = await requestFromProviders({ bases: RPC, path: '/', providerPool,
    request: { method: 'POST', body: JSON.stringify([150, 151].map(height => ({ id: String(height), method: 'block_results', params: { height } }))) },
    fetchImpl: async url => { calls.push(url); return json(url.endsWith('/status') ? head() : result); }
  });
  assert.deepEqual(payload, result);
  assert.equal(calls.filter(url => !url.endsWith('/status')).length, 1);
});

test('pruned state falls back without cooling down healthy current-height reads', async () => {
  const providerPool = pool();
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('/status')) return json(head());
    if (url === `${LIQUIFY_RPC}/block_results?height=150`) return json({ error: { message: 'Internal error', data: 'height 150 is not available' } });
    return json({ result: { height: url.endsWith('151') ? '151' : '150' } });
  };
  await requestFromProviders({ bases: RPC, path: '/block_results?height=150', providerPool, fetchImpl });
  await requestFromProviders({ bases: [LIQUIFY_RPC], path: '/block_results?height=151', providerPool, fetchImpl });
  assert.equal(calls.at(-1), `${LIQUIFY_RPC}/block_results?height=151`);
});

test('retention refresh removes newly pruned heights from NativeSwap scheduling', async () => {
  let now = NOW, earliest = 100;
  const providerPool = pool({ now: () => now, startIndex: 1 });
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const status = head(earliest); status.result.sync_info.latest_block_time = new Date(now).toISOString();
    return json(url.endsWith('/status') ? status : { result: { height: '150' } });
  };
  const run = () => requestFromProviders({ bases: RPC, path: '/block_results?height=150', providerPool, fetchImpl });
  await run(); assert.ok(calls.at(-1).startsWith(NATIVESWAP_RPC));
  now += 61_000; earliest = 151;
  await run(); await run();
  assert.equal(calls.filter(url => url === `${NATIVESWAP_RPC}/block_results?height=150`).length, 1);
  assert.equal(calls.filter(url => url.endsWith('/status')).length, 2);
});

test('a stale, wrong-network, or catching-up NativeSwap node is not assigned historical batches', async () => {
  for (const mutate of [
    (value) => { value.result.sync_info.catching_up = true; },
    (value) => { value.result.node_info.network = 'stagenet'; },
    (value) => { value.result.sync_info.latest_block_time = new Date(NOW - 600_000).toISOString(); }
  ]) {
    const providerPool = pool();
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const value = head(); mutate(value);
      return json(url.endsWith('/status') ? value : { result: { height: '150' } });
    };
    for (let i = 0; i < 2; i++) await requestFromProviders({ bases: RPC, path: '/block_results?height=150', fetchImpl, providerPool });
    assert.equal(calls.filter((url) => url === `${NATIVESWAP_RPC}/block_results?height=150`).length, 0);
  }
});

test('JSON-RPC errors and mismatched heights fail over before returning a response', async () => {
  for (const invalid of [{ error: { code: -32603, message: 'height unavailable' } }, { result: { height: '149' } }]) {
    const providerPool = pool({ startIndex: 1 });
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/status')) return json(head());
      return json(url.startsWith(NATIVESWAP_RPC) ? invalid : { result: { height: '150' } });
    };
    const result = await requestFromProviders({ bases: RPC, path: '/block_results?height=150', fetchImpl, providerPool });
    assert.equal(result.result.height, '150');
    assert.deepEqual(calls.slice(-2), [`${NATIVESWAP_RPC}/block_results?height=150`, `${LIQUIFY_RPC}/block_results?height=150`]);
  }
});

test('explicit source pins, unrelated providers, Midgard, historical REST, and writes are not load-balanced', async () => {
  const providerPool = pool({ startIndex: 1 });
  const cases = [
    { bases: [LIQUIFY_THORNODE], path: '/thorchain/pools' },
    { bases: ['https://first.example', 'https://second.example'], path: '/anything' },
    { bases: ['https://gateway.liquify.com/chain/thorchain_midgard/v2'], path: '/history/swaps' },
    { bases: API, path: '/thorchain/pools?height=150' },
    { bases: API, path: '/cosmos/bank/v1beta1/supply', headers: { 'x-cosmos-block-height': '150' } },
    { bases: RPC, path: '/broadcast_tx_sync?tx=0x00' },
    { bases: RPC, path: '/', request: { method: 'POST', body: JSON.stringify({ method: 'broadcast_tx_sync', params: { tx: '00' } }) } }
  ];
  for (const options of cases) {
    const calls = [];
    await requestFromProviders({ ...options, providerPool, fetchImpl: async (url) => (calls.push(url), json({ ok: true })) });
    assert.deepEqual(calls, [options.bases[0] + options.path]);
  }
});

test('dedicated Liquify remains the Liquify lane; archive alternates are failover only', async () => {
  const providerPool = pool();
  const dedicated = 'https://gateway.liquify.com/api=test-private-key';
  const archive = 'https://rpc.thorchain.liquify.com';
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), json(url.endsWith('/status') ? head() : { result: { height: '150' } }));
  for (let i = 0; i < 4; i++) await requestFromProviders({ bases: [dedicated, archive, NATIVESWAP_RPC],
    path: '/block_results?height=150', fetchImpl, providerPool });
  assert.equal(calls.filter((url) => url.startsWith(dedicated)).length, 2);
  assert.equal(calls.filter((url) => url.startsWith(archive)).length, 0);
});
