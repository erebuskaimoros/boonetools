import test from 'node:test';
import assert from 'node:assert/strict';
import { isProviderRateLimitError } from '../shared/provider-policy.js';
import { MidgardClient, isMidgardRateLimitError as browserPolicy } from '../src/lib/api/midgard.js';
import { fetchMidgardActions as fetchRapidActions, isRapidSwapRateLimitError as rapidPolicy } from '../shared/rapid-swaps/backend.js';

// Rujira's module also defines database-backed ingestion jobs; these policy
// checks never connect to Postgres, but its import requires configured state.
process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
const { fetchMidgardActions: fetchBackendActions, isMidgardRateLimitError: backendPolicy } = await import('../backend/src/shared/midgard.js');
const { isRujiraBaseFeeProviderRateLimit: rujiraPolicy } = await import('../backend/src/shared/rujira-base-fees.js');

test('all Midgard callers agree on quota versus oversized-response failures', () => {
  const errors = [
    { status: 429, message: 'grpc: received message larger than max (8388609 vs. 8388608)' },
    { status: 429, message: 'grpc: received message larger than max', retryAfterSeconds: 60 },
    { status: 429, message: 'Too Many Requests' },
    { status: 503, body: 'daily request limit reached' },
    { status: 503, body: { error: 'rune pouch is empty' } },
    { message: 'Request failed (429)' },
    { message: 'HTTP/1.1 429 Too Many Requests' },
    { status: '429', message: 'upstream unavailable' },
    { status: 413, message: 'payload too large' },
    { status: 500, message: 'block 429123 unavailable' }
  ];
  for (const policy of [browserPolicy, backendPolicy, rapidPolicy, rujiraPolicy]) {
    for (const error of errors) assert.equal(policy(error), isProviderRateLimitError(error), JSON.stringify(error));
  }
});

const callers = {
  browser: (bases) => new MidgardClient({ bases }).getActions({ limit: 50 }, { cache: false }),
  backend: (bases) => fetchBackendActions({ limit: 50 }, { bases, sharedCooldown: false, midgardBudget: false }),
  rapid: (bases) => fetchRapidActions({ limit: 50, bases })
};

for (const [name, fetchActions] of Object.entries(callers)) {
  test(`${name} Midgard falls back after a request-size 429`, async (t) => {
    const bases = [`https://${name}-size-primary.example/v2`, `https://${name}-size-fallback.example/v2`];
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(url);
      return calls.length === 1
        ? new Response('grpc: received message larger than max (8388609 vs. 8388608)', { status: 429 })
        : Response.json({ actions: [{ height: '123' }] });
    });

    assert.equal((await fetchActions(bases)).actions.length, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].startsWith(bases[0]));
    assert.ok(calls[1].startsWith(bases[1]));
  });

  test(`${name} Midgard stops after an actual quota 429`, async (t) => {
    const bases = [`https://${name}-quota-primary.example/v2`, `https://${name}-quota-fallback.example/v2`];
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(url);
      return new Response('daily request limit reached', { status: 429 });
    });

    await assert.rejects(() => fetchActions(bases), (error) => isProviderRateLimitError(error));
    assert.equal(calls.length, 1);
  });
}

for (const [name, options, invalidPayload] of [
  ['txid', { txId: 'target-tx' }, { actions: [{ in: [{ txID: 'wrong-tx' }] }] }],
  ['cursor', { nextPageToken: 'cursor-2' }, { actions: [], meta: { nextPageToken: 'cursor-2' } }],
  ['height', { fromHeight: 100 }, { actions: [{ height: '99' }] }],
  ['limit', { limit: 49 }, { actions: Array.from({ length: 50 }, (_, height) => ({ height })) }]
]) {
  test(`Rapid Midgard retains isolated ${name} validation and provider fallback`, async (t) => {
    const bases = [`https://rapid-${name}-primary.example/v2`, `https://rapid-${name}-fallback.example/v2`];
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(url);
      return Response.json(calls.length === 1 ? invalidPayload : {
        actions: [{ height: '101', in: [{ txID: 'TARGET-TX' }] }],
        meta: { nextPageToken: 'cursor-3' }
      });
    });

    const result = await fetchRapidActions({ bases, limit: 50, ...options });
    assert.equal(result.actions[0].height, '101');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].startsWith(bases[1]));
  });
}
