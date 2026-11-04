import assert from 'node:assert/strict';
import test from 'node:test';
import { createComparisonRequest } from '../../shared/protocol-fee-comparison/request.js';
import { comparisonRequest, runProtocolFeeComparison } from '../src/jobs/protocol-fee-comparison.js';
import { buildComparisonPayload, collectComparison, emptyComparisonCache } from '../src/protocol-fee-comparison/collector.js';
import { ProviderCooldownError } from '../../shared/provider-policy.js';
import { ProviderRequestError } from '../../shared/provider-client.js';
import { requestFromProviders } from '../src/lib/provider-client.js';
import { providerLifecycleHooks } from '../src/shared/provider-cooldown.js';
import { createThorchainProviderPool } from '../../shared/thorchain-provider-pool.js';

test('comparison retries a transient Midgard health failure before abandoning the six-hour refresh', async () => {
  let currentTime = Date.parse('2026-11-04T00:20:00Z');
  const cache = emptyComparisonCache(), calls = [], waits = [];
  let healthCalls = 0;
  const start = Date.parse('2026-11-03') / 1000;
  const result = await collectComparison({ cache, now: currentTime, startDay: '2026-11-03', maxFlipDays: 0,
    clock: () => currentTime, wait: async ms => { waits.push(ms); currentTime += ms; },
    nearNetSupplyReader: async () => [], walletQuery: async () => ({ rows: [] }),
    request: async (route, options) => {
      calls.push(route);
      if (route === '/health') {
        assert.equal(options.service, 'midgard');
        if (++healthCalls === 1) throw Object.assign(new Error('HTTP 500 Internal Server Error'), { status: 500 });
        return { lastAggregated: { timestamp: start + 86400 } };
      }
      if (route.startsWith('/history/earnings?')) return { intervals: [{ startTime: start, endTime: start + 86400,
        liquidityFees: '100', blockRewards: '50', runePriceUSD: '0.6' }] };
      throw new Error('Unrelated fixture source unavailable');
    }
  });
  assert.equal(healthCalls, 2);
  assert.deepEqual(waits, [60_000]);
  assert.equal(calls.filter(route => route.startsWith('/history/earnings?')).length, 1);
  assert.equal(cache.days['2026-11-03']?.earnings.liquidityFees, '100');
  assert.ok(!result.sourceErrors.some(message => message.startsWith('THORChain:')));
});

function healthFixture(healthResponse, extra = {}) {
  let currentTime = Date.parse('2026-11-04T00:20:00Z'), healthCalls = 0;
  const calls = [], waits = [], cache = emptyComparisonCache();
  const start = Date.parse('2026-11-03') / 1000;
  const earnings = { liquidityFees: '100', blockRewards: '50', runePriceUSD: '0.6' };
  cache.days['2026-11-03'] = { earnings: { ...earnings }, preserved: 'verified checkpoint' };
  const options = { cache, now: currentTime, startDay: '2026-11-03', maxFlipDays: 0,
    clock: () => currentTime, wait: async ms => { waits.push(ms); currentTime += ms; },
    nearNetSupplyReader: async () => [], walletQuery: async () => ({ rows: [{ day: '2026-11-03', frontend_near: 0, other_near: 1 }] }),
    request: async (route, requestOptions) => {
      calls.push(route);
      if (route === '/health') return healthResponse(++healthCalls, currentTime, requestOptions);
      if (route.startsWith('/history/earnings?')) return { intervals: [{ startTime: start, endTime: start + 86400, ...earnings }] };
      if (route.includes('/summary/fees/')) return { totalDataChart: [[start, 10]] };
      if (route.includes('/chart/')) return { coins: {} };
      throw new Error(`Unexpected fixture route ${route}`);
    }, ...extra
  };
  return { cache, calls, waits, options, healthCalls: () => healthCalls };
}
const readyHealth = () => ({ lastAggregated: { timestamp: Date.parse('2026-11-04') / 1000 } });

test('real comparison HTTP 500 records a service cooldown and retries through normal admission after expiry', async t => {
  let currentTime = Date.parse('2026-11-04T00:20:00Z');
  const base = 'https://gateway.liquify.com/api=comparison-health-test/v2';
  const requests = [], waits = [], breakers = new Map(), failures = [], admissions = [];
  const start = Date.parse('2026-11-03') / 1000;
  t.mock.method(Date, 'now', () => currentTime);
  const client = { query: async (sql, params) => {
    if (sql.includes('select provider_key')) {
      admissions.push([...params[0]]);
      return { rows: params[0].flatMap(key => breakers.has(key) ? [breakers.get(key)] : []) };
    }
    if (sql.includes('insert into provider_circuit_breakers')) {
      const failure = { provider_key: params[0], last_status: params[1], failure_count: 1,
        last_error: params[2], blocked_until: params[3] };
      breakers.set(params[0], failure);
      failures.push(failure);
    }
    if (sql.includes('update provider_circuit_breakers')) breakers.delete(params[0]);
    return { rows: [] };
  } };
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push({ url: String(url), at: currentTime });
    if (requests.length === 1) return new Response('no available nodes', { status: 500 });
    const payload = String(url).endsWith('/health') ? readyHealth() : { intervals: [{
      startTime: start, endTime: start + 86400, liquidityFees: '100', blockRewards: '50', runePriceUSD: '0.6'
    }] };
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
  // Unit-test NODE_ENV normally disables durable cooldowns. Explicitly enable
  // the production lifecycle hooks while keeping the unrelated daily budget off.
  const hooks = providerLifecycleHooks({ client, scope: 'protocol-fee-comparison', enabled: true });
  const providerPool = createThorchainProviderPool({ now: () => currentTime, failureCooldownMs: 60_000 });
  const realRequest = comparisonRequest(client, { midgardBases: [base],
    transport: options => requestFromProviders({ ...options, ...hooks, providerPool, midgardBudget: false }) });
  const fixture = healthFixture(() => { throw new Error('Fixture health must use the real request'); });
  const result = await collectComparison({ ...fixture.options, clock: () => currentTime,
    request: (route, options) => route.startsWith('/') ? realRequest(route, options) : fixture.options.request(route, options),
    wait: async (ms, { signal }) => {
      waits.push(ms);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].last_status, 500);
      assert.match(failures[0].provider_key, /^service:/);
      assert.equal(Date.parse(failures[0].blocked_until), currentTime + 60_000);
      await assert.rejects(realRequest('/health', { service: 'midgard', signal }), ProviderCooldownError);
      assert.equal(requests.length, 1, 'cooldown admission must prevent another outbound call');
      currentTime += ms;
    }
  });
  assert.deepEqual(waits, [60_000]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(0, 2).map(request => request.url), [`${base}/health`, `${base}/health`]);
  assert.equal(requests[1].at - requests[0].at, 60_000);
  assert.match(requests[2].url, /\/history\/earnings\?/);
  assert.equal(admissions.length, 3, 'both health attempts and earnings retain durable admission');
  assert.equal(breakers.size, 0, 'expired service failures are cleared on readmission');
  assert.equal(fixture.cache.days['2026-11-03'].earnings.liquidityFees, '100');
  assert.deepEqual(result.sourceErrors, []);
});

test('short service cooldown waits for expiry and resumes through normal admission without replaying other sources', async () => {
  const fixture = healthFixture((attempt, now) => {
    if (attempt === 1) throw new ProviderCooldownError('service:midgard.test/v2:health', new Date(now + 35_000).toISOString());
    return readyHealth();
  });
  const result = await collectComparison(fixture.options);
  assert.equal(fixture.healthCalls(), 2);
  assert.deepEqual(fixture.waits, [35_000]);
  for (const route of new Set(fixture.calls.filter(route => route !== '/health'))) {
    assert.equal(fixture.calls.filter(value => value === route).length, 1, route);
  }
  assert.equal(fixture.calls.filter(route => route.includes('/summary/fees/')).length, 2);
  assert.equal(fixture.cache.days['2026-11-03'].preserved, 'verified checkpoint');
  assert.deepEqual(result.sourceErrors, []);
});

test('repeated transient health failures stop after three attempts and two minutes of waits', async () => {
  const fixture = healthFixture(() => { throw new ProviderRequestError('health unavailable', { status: 503 }); });
  const result = await collectComparison(fixture.options);
  assert.equal(fixture.healthCalls(), 3);
  assert.deepEqual(fixture.waits, [60_000, 60_000]);
  assert.equal(fixture.calls.filter(route => route.startsWith('/history/earnings?')).length, 0);
  assert.deepEqual(fixture.cache.days['2026-11-03'].earnings, { liquidityFees: '100', blockRewards: '50', runePriceUSD: '0.6' });
  assert.deepEqual(result.sourceErrors, ['THORChain: health unavailable']);
  assert.equal(result.deferred, false);
});

test('transient HTTP and transport failures each recover without retrying successful earnings', async () => {
  for (const failure of [
    new ProviderRequestError('timeout', { status: 408 }), new ProviderRequestError('too early', { status: 425 }),
    new ProviderRequestError('unavailable', { status: 503 }), new TypeError('fetch failed'),
    new DOMException('Request timed out', 'TimeoutError'), new DOMException('Request timed out', 'AbortError')
  ]) {
    const fixture = healthFixture(attempt => { if (attempt === 1) throw failure; return readyHealth(); });
    const result = await collectComparison(fixture.options);
    assert.equal(fixture.healthCalls(), 2, failure.message);
    assert.deepEqual(fixture.waits, [60_000], failure.message);
    assert.equal(fixture.calls.filter(route => route.startsWith('/history/earnings?')).length, 1);
    assert.deepEqual(result.sourceErrors, []);
  }
});

test('successive service cooldowns cannot exceed the cumulative two-minute wait allowance', async () => {
  const fixture = healthFixture((_attempt, now) => {
    throw new ProviderCooldownError('service:midgard.test/v2:health', new Date(now + 70_000).toISOString());
  });
  const result = await collectComparison(fixture.options);
  assert.equal(fixture.healthCalls(), 2);
  assert.deepEqual(fixture.waits, [70_000]);
  assert.ok(result.sourceErrors[0].startsWith('THORChain:'));
});

test('health retry refuses quota deferrals, gateway cooldowns, Retry-After, long cooldowns and permanent failures', async () => {
  const now = Date.parse('2026-11-04T00:20:00Z');
  const errors = [
    new ProviderCooldownError('service:midgard.test/v2:health', new Date(now + 121_000).toISOString()),
    new ProviderCooldownError('global:midgard.test', new Date(now + 30_000).toISOString()),
    new ProviderCooldownError('service:midgard.test/v2:health', new Date(now + 30_000).toISOString(), 'HTTP 503 [Retry-After: 30s]'),
    Object.assign(new Error('quota exhausted'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt: new Date(now + 30_000).toISOString() }),
    Object.assign(new Error('budget canceled'), { code: 'MIDGARD_BUDGET_ABORTED', name: 'AbortError' }),
    new ProviderRequestError('rate limited', { status: 429 }),
    new ProviderRequestError('unavailable with Retry-After', { status: 503, retryAfterSeconds: 30 }),
    new ProviderRequestError('not found', { status: 404 }),
    new ProviderRequestError('invalid health response'),
    new ProviderRequestError('Invalid JSON', { cause: new SyntaxError('Unexpected token') })
  ];
  for (const failure of errors) {
    const fixture = healthFixture(() => { throw failure; });
    const result = await collectComparison(fixture.options);
    assert.equal(fixture.healthCalls(), 1, failure.message);
    assert.deepEqual(fixture.waits, [], failure.message);
    assert.ok(result.sourceErrors.some(error => error.startsWith('THORChain:')), failure.message);
  }
});

test('successful invalid health responses are not retried', async () => {
  for (const health of [null, {}, { lastAggregated: {} }, { lastAggregated: { timestamp: -1 } }]) {
    const fixture = healthFixture(() => health);
    const result = await collectComparison(fixture.options);
    assert.equal(fixture.healthCalls(), 1);
    assert.deepEqual(fixture.waits, []);
    assert.deepEqual(result.sourceErrors, ['THORChain: Missing aggregation watermark']);
  }
});

test('health retry caps waiting at the remaining run budget and never starts a late request', async () => {
  const fixture = healthFixture(() => { throw new ProviderRequestError('health unavailable', { status: 500 }); }, { maxRunMs: 30_000 });
  const result = await collectComparison(fixture.options);
  assert.deepEqual(fixture.waits, [30_000]);
  assert.equal(fixture.healthCalls(), 1);
  assert.deepEqual(fixture.calls, ['/health']);
  assert.equal(result.deferred, true);
  assert.deepEqual(result.sourceErrors, []);
  assert.match(result.payload.errors.join(' '), /budget.*deferred/);
});

test('a real collector deadline aborts a pending health cooldown wait', { timeout: 2000 }, async () => {
  let aborted = false;
  const fixture = healthFixture(() => { throw new ProviderRequestError('health unavailable', { status: 503 }); }, {
    maxRunMs: 25, clock: Date.now,
    wait: async (_ms, { signal }) => new Promise((_resolve, reject) => {
      const abort = () => { aborted = true; reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    })
  });
  const result = await collectComparison(fixture.options);
  assert.equal(aborted, true);
  assert.equal(fixture.healthCalls(), 1);
  assert.deepEqual(fixture.calls, ['/health']);
  assert.equal(result.deferred, true);
  assert.deepEqual(result.sourceErrors, []);
});

test('source transport forwards cancellation to fetch without recording a provider outage', async (t) => {
  const controller = new AbortController();
  const reason = new Error('acquisition budget reached');
  let providerErrors = 0, seenSignal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    seenSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const request = createComparisonRequest({ hooks: { onProviderError: () => providerErrors++ } });
  const pending = request('https://mainnet-archive.chainflip.io', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(seenSignal);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(seenSignal.aborted, true);
  assert.equal(providerErrors, 0);
});

test('a budget abort after response headers cancels body reading without a source failure', { timeout: 2000 }, async (t) => {
  let calls = 0, readingBody = false, bodyAborted = false, providerErrors = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    calls++;
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: async () => {
      readingBody = true;
      return new Promise((_resolve, reject) => {
        const abort = () => { bodyAborted = true; reject(new DOMException('Body reading aborted', 'AbortError')); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    } };
  });
  const result = await collectComparison({ now: Date.parse('2026-09-03'), startDay: '2026-09-01', maxRunMs: 25,
    request: createComparisonRequest({ hooks: { onProviderError: () => providerErrors++ } }) });
  assert.equal(readingBody, true);
  assert.equal(bodyAborted, true);
  assert.equal(calls, 1);
  assert.equal(providerErrors, 0);
  assert.equal(result.deferred, true);
  assert.deepEqual(result.sourceErrors, []);
  assert.match(result.payload.errors.join(' '), /budget.*deferred/);
});

test('FastNear pacing is abortable and a canceled queue entry never starts transport', async (t) => {
  let now = 10_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const request = createComparisonRequest({ transport: async () => ++calls });
  const url = 'https://archival-rpc.mainnet.fastnear.com';
  assert.equal(await request(url), 1);
  const controller = new AbortController();
  const reason = new Error('acquisition budget reached');
  const pending = request(url, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls, 1);
  now += 1200;
  assert.equal(await request(url), 2, 'aborted pacing must not poison the next run');
});

test('collector awaits a canceled request settling and rejects its late response before cache mutation', { timeout: 2000 }, async () => {
  let settled = false, calls = 0;
  const cache = emptyComparisonCache();
  const result = await collectComparison({ cache, now: Date.parse('2026-09-03'), startDay: '2026-09-01', maxRunMs: 10,
    request: async () => {
      calls++;
      // Deliberately ignores cancellation; the collector must not return early
      // and then continue parsing or mutating once this response arrives.
      await new Promise(resolve => setTimeout(resolve, 25));
      settled = true;
      return { lastAggregated: { timestamp: Date.parse('2026-09-03') / 1000 } };
    }
  });
  assert.equal(settled, true);
  assert.equal(calls, 1);
  assert.deepEqual(cache.days, {});
  assert.equal(result.deferred, true);
  assert.deepEqual(result.sourceErrors, []);
});

function jobFixture() {
  const cache = emptyComparisonCache();
  cache.days['2026-09-01'] = {
    earnings: { liquidityFees: '200000000', blockRewards: '100000000', runePriceUSD: '1' },
    nearRevenue: 3, nearPrice: 1, nearIssuance: 1,
    nearNetIssuanceAtomic: '1000000000000000000000000', nearNetIssuanceMethod: 'onchain-utc-net-supply-v1',
    wallets: { frontend_near: 0, other_near: 1 },
    chainflipRevenue: 4, flipPrice: 1, flipIssuance: { atomic: '1000000000000000000' }
  };
  const now = Date.parse('2026-09-02T12:00:00Z');
  const payload = buildComparisonPayload(cache, { now, startDay: '2026-09-01', errors: ['Remaining work deferred'] });
  const published = [];
  const client = { query: async (sql, args = []) => {
    if (/insert into api_read_models/.test(sql)) {
      published.push(args[2]);
      return { rows: [{ model_key: args[0], payload_json: args[2] }] };
    }
    return { rows: [] };
  } };
  return { now, payload, published, lockRunner: async (_key, run) => run(client) };
}

test('budget-only deferral publishes successfully and passes runtime options to the collector', async () => {
  const fixture = jobFixture(), clock = () => 123;
  const result = await runProtocolFeeComparison({ ...fixture, maxRunMs: 60_000, clock,
    collector: async options => {
      assert.equal(options.now, fixture.now);
      assert.equal(options.maxRunMs, 60_000);
      assert.equal(options.clock, clock);
      return { payload: fixture.payload, sourceErrors: [], deferred: true };
    }
  });
  assert.equal(result.deferred, true);
  assert.equal(fixture.published.at(-1), fixture.payload);
});

test('real source failures still fail the job after publishing checkpointed progress', async () => {
  const fixture = jobFixture();
  await assert.rejects(runProtocolFeeComparison({ ...fixture,
    collector: async () => ({ payload: fixture.payload, sourceErrors: ['NEAR HTTP 429'], deferred: true })
  }), /NEAR HTTP 429/);
  assert.equal(fixture.published.at(-1), fixture.payload);
});
