import test from 'node:test';
import assert from 'node:assert/strict';

function createJsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get(name) {
        if (String(name || '').toLowerCase() === 'content-type') {
          return 'application/json';
        }
        return null;
      }
    },
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    }
  };
}

function fallbackPayload(url) {
  if (url.endsWith('/thorchain/network')) {
    return { rune_price_in_tor: '123000000' };
  }
  if (url.endsWith('/thorchain/pools')) {
    return [{ asset: 'THOR.RUNE', asset_tor_price: '123000000' }];
  }
  if (url.includes('/cosmos/bank/v1beta1/balances/')) {
    return { balances: [{ denom: 'rune', amount: '100000000' }] };
  }
  if (url.includes('/smart/')) {
    return { data: { target_addresses: [['thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr', '50']] } };
  }
  if (url.includes('/history')) {
    return { entries: [{ operation: 'CONTRACT_CODE_HISTORY_OPERATION_TYPE_INIT', code_id: '159' }] };
  }
  throw new Error(`Unexpected fallback URL: ${url}`);
}

test('fetchAppLayerLiveStatePayload builds a backend snapshot through the Thornode fallback', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  process.env.THORNODE_URLS = [
    'https://gateway.liquify.com/chain/thorchain_api',
    'https://thornode-fallback.example'
  ].join(',');
  const [
    { fetchAppLayerLiveStatePayload },
    { THORNODE_FALLBACK, THORNODE_PRIMARY }
  ] = await Promise.all([
    import('../src/shared/app-layer-live-state.js'),
    import('../src/shared/thornode.js')
  ]);
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (String(url).startsWith(THORNODE_PRIMARY)) {
      return createJsonResponse({ error: 'blocked' }, 403);
    }

    if (String(url).startsWith(THORNODE_FALLBACK)) {
      return createJsonResponse(fallbackPayload(String(url)));
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const payload = await fetchAppLayerLiveStatePayload();

    assert.equal(payload.source, 'boonetools-backend');
    assert.equal(payload.network.rune_price_in_tor, '123000000');
    assert.equal(payload.balances.length, 1);
    assert.equal(Object.keys(payload.collector_balances).length, 5);
    assert.equal(Object.keys(payload.configs).length, 5);
    assert.equal(Object.keys(payload.actions).length, 5);
    assert.equal(Object.keys(payload.histories).length, 5);
    assert.deepEqual(payload.route_query_failures, []);
    assert.equal(payload.warning, '');
    assert.ok(calls.some((url) => String(url).startsWith(THORNODE_PRIMARY)));
    assert.ok(calls.some((url) => String(url).startsWith(THORNODE_FALLBACK)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('App Layer refresh reuses slow config/history routes and bounds volatile route fan-out', async () => {
  const { fetchAppLayerLiveStatePayload } = await import('../src/shared/app-layer-live-state.js');
  const now = new Date('2026-07-27T12:00:00.000Z');
  const previousRouteValues = Object.fromEntries(
    ['trade', 'core', 'swap', 'index', 'base'].map((key) => [key, [{ cached: key }]])
  );
  const previous = {
    configs: previousRouteValues,
    histories: previousRouteValues,
    collector_balances: previousRouteValues,
    actions: previousRouteValues,
    route_fetched_at: {
      config: Object.fromEntries(Object.keys(previousRouteValues).map((key) => [key, now.toISOString()])),
      history: Object.fromEntries(Object.keys(previousRouteValues).map((key) => [key, now.toISOString()]))
    }
  };
  let active = 0;
  let maxActive = 0;
  const paths = [];
  const fetchThorchain = async (path) => {
    paths.push(path);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    if (path.includes('/balances/')) return { balances: [] };
    if (path.includes('/smart/')) return { data: { actions: [] } };
    throw new Error(`Unexpected route ${path}`);
  };
  const payload = await fetchAppLayerLiveStatePayload({
    now: () => now,
    previousSnapshot: previous,
    coreSnapshot: { network: {}, pools: [], stale: false },
    fetchThorchain,
    routeConcurrency: 3
  });

  assert.equal(paths.length, 10);
  assert.equal(paths.some((path) => path.endsWith('/history')), false);
  assert.equal(maxActive <= 3, true);
  assert.deepEqual(payload.configs, previous.configs);
  assert.deepEqual(payload.histories, previous.histories);
});
