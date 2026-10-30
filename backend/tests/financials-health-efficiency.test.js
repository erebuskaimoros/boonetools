import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialsProviderRequest } from '../src/jobs/financials.js';
import { acquisitionMetrics } from '../src/lib/acquisition-metrics.js';

const start = Date.parse('2026-10-29T12:00:00Z');
const health = at => ({ database: true, inSync: true,
  lastAggregated: { timestamp: at / 1000, height: 29000000 } });

test('daily and hourly polling share healthy watermarks until another five-minute bucket can exist', async () => {
  let clock = start, calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => clock,
    transport: async () => { calls++; return health(clock); } });
  for (let seconds = 0; seconds < 3600; seconds += 30) {
    clock = start + seconds * 1000;
    const responses = await Promise.all([
      request('/health', { lane: 'live' }),
      ...(seconds % 60 === 0 ? [request('/health', { lane: 'hourly' })] : [])
    ]);
    for (const result of responses) assert.equal(
      Math.floor(result.lastAggregated.timestamp / 300), Math.floor(clock / 300000),
      'every newly available five-minute bucket is noticed on its first poll');
  }
  assert.equal(calls, 12, '180 separate daily/hourly checks should need only 12 upstream reads');
});

test('a lagging watermark retries within thirty seconds and can recover at the same wall-clock bucket', async () => {
  let clock = start + 310000, calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => clock,
    transport: async () => { calls++; return health(calls === 1 ? start : clock); } });
  await request('/health', { lane: 'live' });
  clock += 10000;
  await request('/health', { lane: 'hourly' });
  assert.equal(calls, 1, 'overlapping consumers should not hammer a delayed source');
  clock += 20000;
  const recovered = await request('/health', { lane: 'live' });
  assert.equal(calls, 2);
  assert.equal(recovered.lastAggregated.timestamp, clock / 1000);
});

test('shared health checks respect advertised budget deferral without another admission attempt', async () => {
  let clock = start, calls = 0;
  const retryAt = new Date(start + 3600000).toISOString();
  const blocked = Object.assign(new Error('budget deferred'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt });
  const request = createFinancialsProviderRequest({}, { now: () => clock,
    transport: async () => { calls++; if (clock < Date.parse(retryAt)) throw blocked; return health(clock); } });
  await assert.rejects(request('/health', { lane: 'live' }), /budget deferred/);
  clock += 60000;
  await assert.rejects(request('/health', { lane: 'hourly' }), /budget deferred/);
  assert.equal(calls, 1);
  clock = Date.parse(retryAt);
  assert.equal((await request('/health')).inSync, true);
  assert.equal(calls, 2);
});

test('cancelled consumers do not receive a cached success, and other services never reuse Midgard health', async () => {
  let calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => start,
    transport: async () => { calls++; return health(start); } });
  await request('/health');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => request('/health', { signal: controller.signal }), { name: 'AbortError' });
  await request('/health', { service: 'rpc' });
  assert.equal(calls, 2);
});

test('bulk deferral never blocks normal health allowance, while successful watermarks are shared', async () => {
  let calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => start, transport: async options => {
    calls++;
    if (options.midgardBudgetClass === 'bulk') throw Object.assign(new Error('bulk exhausted'), {
      code: 'MIDGARD_BUDGET_DEFERRED', retryAt: new Date(start + 3600000).toISOString() });
    return health(start);
  } });
  await assert.rejects(request('/health', { midgardBudgetClass: 'bulk' }), /bulk exhausted/);
  assert.equal((await request('/health', { lane: 'live' })).inSync, true);
  assert.equal((await request('/health', { midgardBudgetClass: 'bulk' })).inSync, true);
  assert.equal(calls, 2);
});

test('unhealthy, invalid and future watermarks retain thirty-second recovery polls', async () => {
  for (const initial of [{ ...health(start), inSync: false }, {}, health(start + 3600000),
    { ...health(start), database: false }, { ...health(start), lastAggregated: { height: 0, timestamp: start / 1000 } }]) {
    let clock = start, calls = 0;
    const request = createFinancialsProviderRequest({}, { now: () => clock,
      transport: async () => { calls++; return calls === 1 ? initial : health(clock); } });
    assert.deepEqual(await request('/health'), initial, 'invalid evidence must reach existing caller validation unchanged');
    clock += 29999; await request('/health'); assert.equal(calls, 1);
    clock++; assert.equal((await request('/health')).lastAggregated.timestamp, clock / 1000);
    assert.equal(calls, 2);
  }
});

test('ordinary health failures retry after thirty seconds and provider retry hints take precedence', async () => {
  for (const [extra, retryMs] of [[{}, 30000], [{ retryAfterSeconds: 120 }, 120000],
    [{ blockedUntil: new Date(start + 180000).toISOString() }, 180000]]) {
    let clock = start, calls = 0;
    const request = createFinancialsProviderRequest({}, { now: () => clock,
      transport: async () => { calls++; if (calls === 1) throw Object.assign(new Error('temporary'), extra); return health(clock); } });
    await assert.rejects(request('/health'), /temporary/);
    clock = start + retryMs - 1; await assert.rejects(request('/health'), /temporary/);
    assert.equal(calls, 1);
    clock++; await request('/health'); assert.equal(calls, 2);
  }
});

test('a canceled joining health waiter leaves the owner and other callers running', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const request = createFinancialsProviderRequest({}, { now: () => start,
    transport: async () => { calls++; await gate; return health(start); } });
  const owner = request('/health');
  const controller = new AbortController();
  const joined = request('/health', { signal: controller.signal });
  controller.abort(); await assert.rejects(joined, { name: 'AbortError' });
  release(); assert.equal((await owner).inSync, true);
  await request('/health'); assert.equal(calls, 1);
});

test('owner cancellation cannot poison the next health fetch or overwrite its newer response', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const request = createFinancialsProviderRequest({}, { now: () => start,
    transport: async () => { const sequence = ++calls; if (sequence === 1) await gate;
      return { ...health(start), marker: sequence }; } });
  const controller = new AbortController();
  const owner = request('/health', { signal: controller.signal });
  const joined = request('/health');
  await Promise.resolve();
  controller.abort(); await assert.rejects(owner, { name: 'AbortError' });
  assert.equal((await request('/health')).marker, 2);
  release(); await assert.rejects(joined, { name: 'AbortError' });
  assert.equal((await request('/health')).marker, 2);
  assert.equal(calls, 2);
});

test('health cache is source-instance scoped, bounded to its next bucket, and invalidated by clock rollback', async () => {
  let clock = start + 299000, calls = 0;
  const make = () => createFinancialsProviderRequest({}, { now: () => clock,
    transport: async () => { calls++; return health(clock); } });
  const first = make(), otherSource = make();
  await first('/health'); await otherSource('/health'); assert.equal(calls, 2);
  clock += 1000; await first('/health'); assert.equal(calls, 3, 'no cached result across the next source bucket');
  clock = start; await first('/health'); assert.equal(calls, 4, 'future observations cannot survive a backward clock jump');
  await first('/health?extra=1'); await first('/health?extra=1'); assert.equal(calls, 6, 'only exact health route is cached');
});

test('health cache reports hits, misses and in-flight sharing without counting new provider attempts', async () => {
  acquisitionMetrics({ reset: true });
  const request = createFinancialsProviderRequest({}, { now: () => start, transport: async () => health(start) });
  await Promise.all([request('/health'), request('/health')]); await request('/health');
  const metrics = acquisitionMetrics({ reset: true });
  assert.deepEqual(metrics.caches.find(row => row.namespace === 'financials:midgard-health'), {
    namespace: 'financials:midgard-health', hit: 1, miss: 1, coalesced: 1
  });
  assert.deepEqual(metrics.providers, [], 'only the real transport records outgoing requests');
});
