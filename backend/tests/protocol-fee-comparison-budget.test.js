import assert from 'node:assert/strict';
import test from 'node:test';
import { createComparisonRequest } from '../../shared/protocol-fee-comparison/request.js';
import { runProtocolFeeComparison } from '../src/jobs/protocol-fee-comparison.js';
import { buildComparisonPayload, collectComparison, emptyComparisonCache } from '../src/protocol-fee-comparison/collector.js';

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
