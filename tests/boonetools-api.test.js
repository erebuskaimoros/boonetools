import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BooneToolsApiError,
  createBooneToolsApiClient,
  getBooneToolsApiMeta,
  resolveBooneToolsApiConfig
} from '../src/lib/api/boonetools.js';
import { fetchAppLayerLiveState } from '../src/lib/app-layer/api.js';
import { fetchNodeVotesDashboard } from '../src/lib/node-votes/api.js';
import { fetchPolTracker } from '../src/lib/pol-tracker/api.js';
import { fetchStatusLive, fetchStuckTransactions } from '../src/lib/status/api.js';
import { fetchSystemIncomePol } from '../src/lib/system-income-pol/api.js';
import { fetchTcFeeDash } from '../src/lib/tc-fee-dash/api.js';

function createResponse(payload, options = {}) {
  const status = options.status ?? 200;
  const statusText = options.statusText ?? (status === 200 ? 'OK' : 'Error');
  const body = options.rawBody ?? JSON.stringify(payload);

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers(options.headers || { 'content-type': 'application/json' }),
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    }
  };
}

test('canonical BooneTools env values win and normalize to one origin/key', () => {
  const config = resolveBooneToolsApiConfig({
    VITE_BOONETOOLS_API_BASE: ' https://api.boone.tools/functions/v1/// ',
    VITE_BOONETOOLS_API_KEY: 'canonical-key',
    VITE_NODEOP_API_BASE: 'https://legacy.example/functions/v1',
    VITE_NODEOP_API_KEY: 'legacy-key'
  });

  assert.equal(config.base, 'https://api.boone.tools/functions/v1');
  assert.equal(config.key, 'canonical-key');
  assert.equal(config.baseSource, 'VITE_BOONETOOLS_API_BASE');
  assert.equal(config.keySource, 'VITE_BOONETOOLS_API_KEY');
  assert.equal(config.isBaseConfigured, true);
});

test('legacy feature env values remain supported as migration aliases', () => {
  const config = resolveBooneToolsApiConfig({
    VITE_BOONETOOLS_API_BASE: '',
    VITE_RAPID_SWAPS_API_BASE: 'https://legacy.example/functions/v1/',
    VITE_RAPID_SWAPS_API_KEY: 'legacy-key'
  });

  assert.equal(config.base, 'https://legacy.example/functions/v1');
  assert.equal(config.key, 'legacy-key');
  assert.equal(config.baseSource, 'VITE_RAPID_SWAPS_API_BASE');
  assert.equal(config.keySource, 'VITE_RAPID_SWAPS_API_KEY');
});

test('shared client builds query strings and standard authentication headers', async () => {
  let request;
  const client = createBooneToolsApiClient({
    base: 'https://api.example/functions/v1/',
    key: 'public-key',
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return createResponse({ ok: true });
    }
  });

  const payload = await client.get('/node-votes', {
    forceRefresh: true,
    query: {
      days: 45,
      zero: 0,
      disabled: false,
      empty: '',
      missing: null
    },
    cache: 'no-store'
  });

  assert.deepEqual(payload, { ok: true });
  assert.equal(
    request.url,
    'https://api.example/functions/v1/node-votes?ts=1700000000000&days=45&zero=0&disabled=false'
  );
  assert.deepEqual(request.options.headers, {
    Accept: 'application/json',
    apikey: 'public-key',
    Authorization: 'Bearer public-key'
  });
  assert.equal(request.options.cache, 'no-store');
});

test('shared client decodes backend JSON errors and retains response details', async () => {
  const client = createBooneToolsApiClient({
    base: '/functions/v1',
    fetchImpl: async () => createResponse(
      { error: 'database is warming up' },
      { status: 503, statusText: 'Service Unavailable' }
    )
  });

  await assert.rejects(
    () => client.get('/node-votes'),
    (error) => {
      assert.ok(error instanceof BooneToolsApiError);
      assert.equal(error.message, 'database is warming up');
      assert.equal(error.status, 503);
      assert.equal(error.statusText, 'Service Unavailable');
      assert.deepEqual(error.payload, { error: 'database is warming up' });
      return true;
    }
  );
});

test('shared client detects successful HTML challenge responses before JSON parsing', async () => {
  const client = createBooneToolsApiClient({
    fetchImpl: async () => createResponse(null, {
      rawBody: '<html>challenge</html>',
      headers: { 'content-type': 'text/html' }
    })
  });

  await assert.rejects(
    () => client.get('/stuck-transactions', { challengeMessage: 'feature challenge' }),
    (error) => {
      assert.ok(error instanceof BooneToolsApiError);
      assert.equal(error.message, 'feature challenge');
      return true;
    }
  );
});

test('shared client unwraps v2 envelopes without replacing feature-owned metadata', async () => {
  const contractMeta = {
    schemaVersion: 2,
    source: 'postgres',
    asOf: '2026-07-18T01:00:00.000Z'
  };
  const client = createBooneToolsApiClient({
    fetchImpl: async () => createResponse({
      data: {
        rows: [{ id: 1 }],
        meta: { featureWindow: '45d' }
      },
      meta: contractMeta
    })
  });

  const payload = await client.get('/node-votes');

  assert.deepEqual(payload, {
    rows: [{ id: 1 }],
    meta: { featureWindow: '45d' }
  });
  assert.deepEqual(getBooneToolsApiMeta(payload), contractMeta);
});

test('shared client restores the legacy meta field stripped by the server v2 envelope', async () => {
  const contractMeta = {
    schemaVersion: 2,
    source: '/node-votes',
    stale: false,
    featureWindow: '45d'
  };
  const client = createBooneToolsApiClient({
    fetchImpl: async () => createResponse({
      data: { rows: [{ id: 1 }] },
      meta: contractMeta
    })
  });

  const payload = await client.get('/node-votes');

  assert.deepEqual(payload, {
    rows: [{ id: 1 }],
    meta: contractMeta
  });
  assert.equal(payload.meta.schemaVersion, 2);
  assert.deepEqual(getBooneToolsApiMeta(payload), contractMeta);
});

test('active feature adapters retain their public functions and endpoint shapes', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createResponse({ url });
  };

  await fetchStuckTransactions();
  await fetchStatusLive({ revalidate: true });
  await fetchNodeVotesDashboard({ days: 45 });
  await fetchTcFeeDash();
  await fetchAppLayerLiveState();
  await fetchSystemIncomePol({ forceRefresh: true });
  await fetchPolTracker({ forceRefresh: true });

  assert.deepEqual(requests.map((request) => request.url), [
    '/functions/v1/stuck-transactions',
    '/functions/v1/status-live',
    '/functions/v1/node-votes-summary?days=45',
    '/functions/v1/tc-fee-dash',
    '/functions/v1/app-layer-live-state',
    '/functions/v1/pol-tracker',
    '/functions/v1/pol-tvl'
  ]);
  assert.equal(requests[1].options.cache, 'no-cache');
  assert.notEqual(requests[4].options.cache, 'no-store');
  assert.equal(requests[5].options.cache, 'no-cache');
  assert.equal(requests[6].options.cache, 'no-cache');
  assert.equal(requests.every((request) => request.options.headers.Accept === 'application/json'), true);
});
