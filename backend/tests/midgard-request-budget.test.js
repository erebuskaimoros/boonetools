import assert from 'node:assert/strict';
import test from 'node:test';
import { requestFromProviders } from '../src/lib/provider-client.js';
import { createMidgardRequestBudget, midgardBudgetContext, MidgardBudgetDeferredError } from '../src/lib/midgard-request-budget.js';
import { fetchMidgard } from '../src/shared/midgard.js';
import { acquisitionMetrics } from '../src/lib/acquisition-metrics.js';
import { config } from '../src/lib/config.js';
import { createComparisonRequest } from '../../shared/protocol-fee-comparison/request.js';

const BASE = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
const response = () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });

test('backend Midgard requests cannot reach upstream when the shared budget defers them', async () => {
  let claims = 0, calls = 0, failures = 0;
  const deferred = Object.assign(new Error('Midgard budget deferred'), {
    code: 'MIDGARD_BUDGET_DEFERRED', skipProvider: true, retryAt: '2099-01-01T00:00:00Z'
  });
  await assert.rejects(requestFromProviders({
    bases: [BASE], path: '/actions?limit=50', providerPool: false,
    midgardBudget: { claim: async () => { claims++; throw deferred; } },
    fetchImpl: async () => { calls++; return response(); },
    onProviderError: async () => { failures++; }
  }), (error) => error === deferred);
  assert.equal(claims, 1);
  assert.equal(calls, 0, 'budget denials must never create an upstream request');
  assert.equal(failures, 0, 'budget deferral is not a provider failure');
});

test('budget accounting occurs after cooldown availability but before actual fetch', async () => {
  const order = [];
  await requestFromProviders({
    bases: [BASE], path: '/network', providerPool: false,
    beforeRequest: async () => { order.push('cooldown'); },
    midgardBudget: { claim: async () => { order.push('budget'); } },
    fetchImpl: async () => { order.push('fetch'); return response(); }
  });
  assert.deepEqual(order, ['cooldown', 'budget', 'fetch']);
});

test('cooldown denials and non-Midgard requests never spend Midgard budget', async () => {
  let claims = 0, calls = 0;
  const midgardBudget = { claim: async () => { claims++; } };
  const fetchImpl = async () => { calls++; return response(); };
  const cooldown = Object.assign(new Error('cooldown'), { skipProvider: true });
  await assert.rejects(requestFromProviders({ bases: [BASE], path: '/actions', providerPool: false,
    midgardBudget, fetchImpl, beforeRequest: async () => { throw cooldown; } }), (error) => error === cooldown);
  await requestFromProviders({ bases: ['https://gateway.liquify.com/chain/thorchain_api'],
    path: '/thorchain/network', providerPool: false, midgardBudget, fetchImpl });
  assert.equal(claims, 0);
  assert.equal(calls, 1);
});

test('provider versions share budget without coupling public, dedicated, or other credentials', () => {
  const context = (base, path = '/actions?address=private&limit=50', configuredBases = []) =>
    midgardBudgetContext(`${base}${path}`, { bases: [base], configuredBases });
  assert.equal(context(BASE).providerKey,
    context('https://gateway.liquify.com/chain/thorchain_midgard/v1').providerKey);
  assert.equal(context(`${BASE}/`).providerKey, context(BASE).providerKey);
  const first = 'https://gateway.liquify.com/api=private-secret-1/v2';
  const second = 'https://gateway.liquify.com/api=private-secret-2/v2';
  const firstKey = context(first, '/network', [first]).providerKey;
  const secondKey = context(second, '/network', [second]).providerKey;
  assert.notEqual(firstKey, secondKey);
  assert.notEqual(firstKey, context(BASE).providerKey);
  assert.doesNotMatch(firstKey, /private|secret|api=/);
  assert.equal(context('https://gateway.liquify.com/chain/thorchain_api', '/thorchain/network'), null);
  assert.equal(context(BASE).budgetClass, 'bulk');
  assert.equal(context(BASE, '/network').budgetClass, 'live');
  assert.equal(midgardBudgetContext(`${BASE}/health`, {
    bases: [BASE], midgardBudgetClass: 'bulk'
  }).budgetClass, 'bulk');
  assert.equal(midgardBudgetContext(`${BASE}/history/swaps?interval=day`, {
    bases: ['https://gateway.liquify.com']
  })?.providerKey, context(BASE).providerKey, 'origin-based comparison transport must share the same service budget');
  assert.equal(midgardBudgetContext(`${BASE}/actions?limit=50`, {
    bases: ['https://gateway.liquify.com']
  })?.budgetClass, 'bulk');
});

test('origin-based comparison history requests cannot bypass the shared budget', async () => {
  let claims = 0;
  const deferred = new MidgardBudgetDeferredError({ providerKey: 'test', retryAt: '2099-01-01T00:00:00Z', reason: 'total-day' });
  const comparison = createComparisonRequest({ transport: (options) => requestFromProviders({ ...options, providerPool: false,
    midgardBudget: { async claim(context) {
      claims++; assert.equal(context.budgetClass, 'live'); throw deferred;
    } }, fetchImpl: async () => assert.fail('origin-based URL bypassed Midgard budget') }) });
  await assert.rejects(comparison(`${BASE}/history/swaps?interval=day`), (error) => error === deferred);
  assert.equal(claims, 1);
});

test('every actual attempt is budgeted, including upstream failures, without counting denied calls as failures', async () => {
  acquisitionMetrics({ reset: true });
  let claims = 0;
  const options = { bases: [BASE], path: '/actions', providerPool: false,
    midgardBudget: { claim: async () => { claims++; } } };
  await assert.rejects(requestFromProviders({ ...options,
    fetchImpl: async () => new Response('failed upstream', { status: 500 }) }));
  assert.equal(claims, 1);
  let errorCallbacks = 0;
  const denial = new MidgardBudgetDeferredError({ providerKey: 'test', retryAt: '2099-01-01T00:00:00Z', reason: 'bulk-day' });
  await assert.rejects(requestFromProviders({ ...options,
    bases: [BASE, 'https://midgard.example/v2'],
    midgardBudget: { claim: async () => { claims++; throw denial; } },
    onProviderError: async () => { errorCallbacks++; },
    fetchImpl: async () => assert.fail('deferred request reached upstream')
  }), (error) => error === denial);
  assert.equal(claims, 2, 'local deferral must stop rather than retrying another provider');
  assert.equal(errorCallbacks, 0);
  assert.deepEqual(acquisitionMetrics().providers.map(({ attempts, failed }) => [attempts, failed]), [[1, 1]]);
});

test('budget database failures fail closed with retry time and no implicit production database fallback', async () => {
  const timestamp = Date.parse('2099-01-01T00:00:00Z');
  const limits = { minute: 2, hour: 3, day: 4 };
  assert.throws(() => createMidgardRequestBudget({ total: limits, bulk: limits }), /explicit database client/);
  const budget = createMidgardRequestBudget({
    client: { query: async () => { throw new Error('offline'); } },
    total: limits, bulk: limits, now: () => timestamp
  });
  await assert.rejects(budget.claim({ providerKey: 'test' }), (error) => {
    assert.equal(error.code, 'MIDGARD_BUDGET_DEFERRED');
    assert.equal(error.budgetReason, 'storage-unavailable');
    assert.equal(error.retryAt, '2099-01-01T00:01:00.000Z');
    assert.equal(error.retryAfterSeconds, 60);
    assert.equal(error.skipProvider, true);
    assert.equal(error.status, undefined, 'local budget denial is never an upstream 429');
    return true;
  });
  await assert.rejects(requestFromProviders({ bases: [BASE], path: '/network', providerPool: false,
    midgardBudget: budget, fetchImpl: async () => assert.fail('storage outage must fail closed') }),
  { code: 'MIDGARD_BUDGET_DEFERRED' });
});

test('caller cancellation during reservation refunds once and never fetches', async () => {
  const controller = new AbortController();
  let claims = 0, refunds = 0;
  const limits = { minute: 2, hour: 3, day: 4 };
  const budget = createMidgardRequestBudget({
    client: { async query(sql) {
      if (sql.includes('refund_')) { refunds++; return { rows: [] }; }
      claims++; controller.abort();
      return { rows: [{ allowed: true, reserved_at: new Date() }] };
    } }, total: limits, bulk: limits
  });
  await assert.rejects(requestFromProviders({ bases: [BASE], path: '/actions', providerPool: false,
    request: { signal: controller.signal }, midgardBudget: budget,
    fetchImpl: async () => assert.fail('canceled request reached upstream') }), { name: 'AbortError' });
  assert.equal(claims, 1);
  assert.equal(refunds, 1);
  await assert.rejects(budget.claim({ providerKey: 'test', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(claims, 1, 'already aborted callers never reserve quota');
});

test('Midgard helper passes bulk class, injected budget and cancellation to actual transport', async (t) => {
  let claims = 0;
  const controller = new AbortController();
  const deferred = new MidgardBudgetDeferredError({ providerKey: 'test', retryAt: '2099-01-01T00:00:00Z', reason: 'bulk-hour' });
  t.mock.method(globalThis, 'fetch', () => assert.fail('injected denial reached upstream'));
  await assert.rejects(fetchMidgard('/health', { bases: [BASE], sharedCooldown: false,
    midgardBudgetClass: 'bulk', signal: controller.signal,
    midgardBudget: { async claim(context) {
      claims++;
      assert.equal(context.budgetClass, 'bulk');
      assert.ok(context.signal instanceof AbortSignal);
      throw deferred;
    } }
  }), (error) => error === deferred);
  assert.equal(claims, 1);
});

test('admission timeouts cannot create provider breakers or leak a reservation', async () => {
  let callbacks = 0, refunds = 0;
  const budget = createMidgardRequestBudget({ total: { minute: 2, hour: 3, day: 4 }, bulk: { minute: 1, hour: 2, day: 3 },
    client: { async query(sql) {
      if (sql.includes('refund_')) { refunds++; return { rows: [] }; }
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { rows: [{ allowed: true, reserved_at: new Date() }] };
    } }
  });
  await assert.rejects(requestFromProviders({ bases: [BASE], path: '/actions', providerPool: false,
    timeoutMs: 1, midgardBudget: budget,
    onProviderError: async () => { callbacks++; },
    fetchImpl: async () => assert.fail('timed-out admission reached upstream') }),
  { name: 'AbortError', code: 'MIDGARD_BUDGET_ABORTED', skipProvider: true });
  assert.equal(callbacks, 0);
  assert.equal(refunds, 1);
});

test('invalid storage responses fail closed rather than becoming provider failures', async () => {
  const total = { minute: 2, hour: 3, day: 4 };
  for (const row of [undefined, { allowed: true }, { allowed: false, retry_at: 'invalid' }]) {
    const budget = createMidgardRequestBudget({ total, bulk: total,
      client: { query: async () => ({ rows: row ? [row] : [] }) } });
    await assert.rejects(budget.claim({ providerKey: 'invalid' }), { code: 'MIDGARD_BUDGET_DEFERRED', budgetReason: 'storage-unavailable' });
  }
});

test('default safety ceilings reserve daily capacity for non-bulk reads', () => {
  assert.deepEqual(config.midgardRequestBudgetTotal, { minute: 60, hour: 2000, day: 20000 });
  assert.deepEqual(config.midgardRequestBudgetBulk, { minute: 30, hour: 1000, day: 5000 });
});

test('backend rapid-swap scans and source probes cannot bypass the shared transport budget', async (t) => {
  const { fetchRapidSwapRows, fetchRapidSwapSourceStatus } = await import('../src/shared/rapid-swaps.js');
  const { configureRapidSwapProviderLifecycle } = await import('../../shared/rapid-swaps/backend.js');
  const deferred = new MidgardBudgetDeferredError({ providerKey: 'test', retryAt: '2099-01-01T00:00:00Z', reason: 'bulk-day' });
  let claims = 0, calls = 0;
  const budget = { async claim(context) { claims++; assert.equal(context.budgetClass, 'bulk'); throw deferred; } };
  configureRapidSwapProviderLifecycle({
    requestFromProviders: (options) => requestFromProviders({ ...options, midgardBudget: budget, providerPool: false })
  });
  t.after(() => configureRapidSwapProviderLifecycle());
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{"actions":[]}', { headers: { 'content-type': 'application/json' } }); });
  await assert.rejects(fetchRapidSwapRows({ priceIndex: {}, maxPages: 1 }), (error) => error === deferred);
  await fetchRapidSwapSourceStatus({ coreSnapshot: { mimir: {}, inbound_addresses: [], lastblock: [] } });
  assert.equal(claims, 2);
  assert.equal(calls, 0);
});
