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
