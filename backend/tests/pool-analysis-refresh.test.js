import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderCooldownError } from '../src/shared/provider-cooldown.js';
import { fetchMidgard } from '../src/shared/midgard.js';
import { ProviderRequestError, thorchainProviderPool } from '../src/lib/provider-client.js';
import { createThorchainProviderPool } from '../../shared/thorchain-provider-pool.js';
import {
  fetchPoolAnalysisSwapHistory,
  fetchPoolAnalysisDepthHistory,
  ingestPoolAnalysisHistory
} from '../src/shared/pool-analysis-ingestion.js';

const ASSET = 'BTC.BTC';
const NOW = '2026-09-02T12:00:00.000Z';
const unix = (day) => Date.parse(`${day}T00:00:00Z`) / 1000;
const nextDay = (day) => new Date((unix(day) + 86400) * 1000).toISOString().slice(0, 10);

function swap(day, changes = {}) {
  return { asset: ASSET, day, volume_rune_e8: '100', volume_usd_e2: '200',
    fees_rune_e8: '3', rune_price_usd: '2', interval_start: `${day}T00:00:00.000Z`,
    interval_end: `${nextDay(day)}T00:00:00.000Z`, partial: false,
    source: 'liquify-midgard-swaps', ...changes };
}
function depth(day, changes = {}) {
  return { asset: ASSET, day, rune_depth_e8: '500000000', asset_depth_e8: '100000000',
    asset_price_usd: '10', interval_end: `${nextDay(day)}T00:00:00.000Z`,
    partial: false, source: 'liquify-midgard-depths', ...changes };
}
function core(fetchedAt = '2026-09-02T11:59:00.000Z', changes = {}) {
  return { payload: { pools: [{ asset: ASSET, status: 'Available', balance_rune: '500000000',
    balance_asset: '100000000', asset_tor_price: '1000000000' }],
  field_meta: { pools: { fetched_at: fetchedAt, status: 'cached' } }, ...changes } };
}
function fixture({ swaps = [], depths = [], pending = [] } = {}) {
  const data = { swaps: new Map(swaps.map((row) => [row.day, row])),
    depth: new Map(depths.map((row) => [row.day, row])) };
  const calls = [];
  const states = [];
  return { data, calls, states, options: {
    now: NOW, healthNow: NOW, assets: [ASSET], coreSnapshot: core(), skipDelay: true,
    fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 1, timestamp: unix('2026-09-02') } }),
    loadPendingDays: async () => pending.filter(({ lane, day }) => !data[lane].get(day)?.completed_at),
    fetchSwapHistory: async (asset, options) => {
      calls.push({ lane: 'swaps', asset, from: options.startDate, through: options.endDate });
      return { rows: [swap(options.startDate)], pages: 1 };
    },
    fetchDepthHistory: async (asset, options) => {
      calls.push({ lane: 'depth', asset, from: options.startDate, through: options.endDate });
      return { rows: [depth(options.startDate)], pages: 1 };
    },
    upsert: async (_client, rows) => { rows.forEach((row) => data.swaps.set(row.day, row)); return rows.length; },
    upsertDepths: async (_client, rows) => { rows.forEach((row) => data.depth.set(row.day, row)); return rows.length; },
    updateSyncState: async (_client, state) => { states.push(state); }
  } };
}

test('a transient health 503 recovers within the same scheduled pool refresh after the failure cooldown', async () => {
  const f = fixture();
  let clock = Date.parse(NOW);
  const waits = [], requests = [], failures = [];
  let healthCalls = 0;
  const result = await ingestPoolAnalysisHistory({}, { ...f.options, rolling: true,
    healthNow: () => new Date(clock),
    wait: async ms => { waits.push(ms); clock += ms; },
    fetchMidgard: async route => {
      requests.push(route);
      if (route === '/health') {
        if (++healthCalls === 1) throw Object.assign(new Error('Midgard error: 503 Service Unavailable for /health'), { status: 503 });
        return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: clock / 1000 } };
      }
      const query = new URL(route, 'https://midgard.test').searchParams;
      return { meta: { startTime: query.get('from'), endTime: query.get('to'), totalVolume: '100',
        totalVolumeUSD: '200', totalFees: '3', runePriceUSD: '2' } };
    },
    loadRollingEdges: async () => null,
    saveIntradaySnapshot: async () => {},
    loadCompletedDays: async () => [], loadBoundarySnapshots: async () => [],
    saveRollingSnapshot: async () => {},
    markRollingFailure: async (...args) => failures.push(args)
  });
  assert.equal(healthCalls, 2, 'a brief health error must not waste the full 15-minute refresh cycle');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 60_000 && waits[0] <= 120_000, 'respect the short provider cooldown before retrying');
  assert.equal(result.successful_pools, 1);
  assert.equal(result.failed_pools, 0);
  assert.equal(result.watermark_error, '');
  assert.equal(f.data.swaps.get('2026-09-02').volume_rune_e8, '100');
  assert.equal(requests.length, 3, 'retry the health gate once, then acquire the live prefix once');
  assert.deepEqual(failures, []);
});

function healthRecoveryFixture(response) {
  const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' }] });
  let clock = Date.parse(NOW);
  const waits = [], requests = [];
  const options = { ...f.options,
    historyBase: 'https://midgard.example.invalid/v2',
    healthNow: () => new Date(clock),
    wait: async ms => { waits.push(ms); clock += ms; },
    fetchMidgard: async (route, requestOptions) => {
      requests.push({ route, ...requestOptions });
      return response(requests.length, clock);
    }
  };
  return { ...f, waits, requests, options };
}
const readyHealth = clock => ({ database: true, inSync: true,
  lastAggregated: { height: 1, timestamp: clock / 1000 } });

for (const failure of ['HTTP 503', 'transport timeout', 'existing service cooldown']) {
  test(`real Midgard ${failure} recovers through ordinary cooldown admission on the pinned provider`, async t => {
    const base = 'https://gateway.liquify.com/api=pool-health-test/v2';
    const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' }] });
    let clock = Date.parse(NOW);
    const calls = [], waits = [], errors = [], breakers = new Map();
    const localPool = createThorchainProviderPool({ now: () => clock });
    t.mock.method(Date, 'now', () => clock);
    for (const method of ['acquire', 'failure']) t.mock.method(thorchainProviderPool, method, localPool[method]);
    const client = { query: async (sql, params) => {
      if (sql.includes('select provider_key')) return { rows: params[0].flatMap(key => breakers.has(key) ? [breakers.get(key)] : []) };
      if (sql.includes('insert into provider_circuit_breakers')) breakers.set(params[0], {
        provider_key: params[0], failure_count: 1, last_error: params[2], blocked_until: params[3]
      });
      if (sql.includes('update provider_circuit_breakers')) breakers.delete(params[0]);
      return { rows: [] };
    } };
    if (failure === 'existing service cooldown') {
      // This is the actual process-local error, which lacks a stored reason.
      localPool.failure(base, new ProviderRequestError('health unavailable', { status: 503 }), 'midgard-health');
      clock += 25_000;
    }
    t.mock.method(globalThis, 'fetch', async url => {
      calls.push({ url: String(url), at: clock });
      if (calls.length === 1 && failure === 'HTTP 503') return new Response('no available nodes', { status: 503 });
      if (calls.length === 1 && failure === 'transport timeout') throw new DOMException('This operation was aborted', 'AbortError');
      return new Response(JSON.stringify(readyHealth(clock)), { headers: { 'content-type': 'application/json' } });
    });
    const result = await ingestPoolAnalysisHistory(client, { ...f.options,
      historyBase: base, healthNow: () => new Date(clock),
      wait: async ms => { waits.push(ms); clock += ms; },
      fetchMidgard: async (route, options) => {
        try { return await fetchMidgard(route, { ...options, sharedCooldown: true, midgardBudget: false }); }
        catch (error) { errors.push(error); throw error; }
      }
    });
    assert.equal(result.watermark_error, '');
    assert.equal(result.historical_requests, 1);
    assert.equal(f.data.swaps.get('2026-09-01').completed_at, NOW);
    assert.deepEqual(waits, [failure === 'existing service cooldown' ? 35_000 : 60_000]);
    assert.equal(calls.length, failure === 'existing service cooldown' ? 1 : 2);
    assert.ok(calls.every(call => call.url === `${base}/health`));
    assert.equal(errors.length, 1);
    if (failure === 'HTTP 503') assert.ok(errors[0] instanceof ProviderRequestError);
    if (failure === 'transport timeout') assert.equal(errors[0].name, 'AbortError');
    if (failure === 'existing service cooldown') assert.ok(errors[0] instanceof ProviderCooldownError);
  });
}

test('an active short health service cooldown waits until its expiry and keeps the pinned provider', async () => {
  const f = healthRecoveryFixture((attempt, clock) => {
    if (attempt === 1) throw new ProviderCooldownError('service:midgard.example.invalid/v2:health',
      new Date(clock + 35_000).toISOString());
    return readyHealth(clock);
  });
  const result = await ingestPoolAnalysisHistory({}, f.options);
  assert.deepEqual(f.waits, [35_000]);
  assert.equal(result.watermark_error, '');
  assert.equal(result.historical_requests, 1);
  assert.equal(f.data.swaps.get('2026-09-01').completed_at, NOW);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) assert.deepEqual(request.bases, ['https://midgard.example.invalid/v2']);
});

test('repeated health failures stop after three attempts and two minutes of total cooldown waiting', async () => {
  const f = healthRecoveryFixture(() => { throw Object.assign(new Error('health unavailable'), { status: 503 }); });
  const result = await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.waits, [60_000, 60_000]);
  assert.equal(result.watermark_error, 'health unavailable');
  assert.equal(result.historical_requests, 0);
  assert.equal(f.data.swaps.has('2026-09-01'), false);
});

test('long or gateway cooldowns, quota deferrals, and non-transient health failures do not retry', async () => {
  const errors = [
    new ProviderCooldownError('service:midgard.example.invalid/v2:health', new Date(Date.parse(NOW) + 121_000).toISOString()),
    new ProviderCooldownError('global:midgard.example.invalid', new Date(Date.parse(NOW) + 30_000).toISOString()),
    Object.assign(new Error('quota exhausted'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt: new Date(Date.parse(NOW) + 30_000).toISOString() }),
    Object.assign(new Error('budget admission canceled'), { code: 'MIDGARD_BUDGET_ABORTED', name: 'AbortError' }),
    Object.assign(new Error('rate limited'), { status: 429 }),
    Object.assign(new Error('gateway Retry-After'), { status: 503, retryAfterSeconds: 30 }),
    Object.assign(new Error('not found'), { status: 404 }),
    new ProviderRequestError('Midgard returned an unusable response for /health'),
    new ProviderRequestError('Invalid JSON from health', { cause: new SyntaxError('Unexpected token') })
  ];
  for (const failure of errors) {
    const f = healthRecoveryFixture(() => { throw failure; });
    const result = await ingestPoolAnalysisHistory({}, f.options);
    assert.equal(f.requests.length, 1, failure.message);
    assert.deepEqual(f.waits, [], failure.message);
    assert.equal(result.watermark_error, failure.message);
    assert.equal(f.data.swaps.has('2026-09-01'), false);
  }
});

test('invalid or out-of-sync successful health payloads remain unavailable without retries', async () => {
  for (const payload of [null, {}, { ...readyHealth(Date.parse(NOW)), inSync: false }, readyHealth(Date.parse(NOW) + 1)]) {
    const f = healthRecoveryFixture(() => payload);
    const result = await ingestPoolAnalysisHistory({}, f.options);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.waits, []);
    assert.match(result.watermark_error, /watermark unavailable or not in sync/);
    assert.equal(f.data.swaps.has('2026-09-01'), false);
  }
});

test('canceling during health cooldown prevents the retry and stops the run', async () => {
  const controller = new AbortController();
  const reason = new Error('refresh canceled');
  const f = healthRecoveryFixture(() => { throw Object.assign(new Error('health unavailable'), { status: 503 }); });
  await assert.rejects(() => ingestPoolAnalysisHistory({}, { ...f.options, signal: controller.signal,
    wait: async () => controller.abort(reason)
  }), error => error === reason);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal, controller.signal);
  assert.equal(f.states.length, 0);
});

test('an already canceled refresh stops before acquiring or publishing any data', async () => {
  const reason = new Error('refresh already canceled');
  const f = healthRecoveryFixture((_attempt, clock) => readyHealth(clock));
  await assert.rejects(() => ingestPoolAnalysisHistory({}, { ...f.options, signal: AbortSignal.abort(reason) }),
    error => error === reason);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.states, []);
});

test('health recovery crossing UTC midnight advances the live day and finalizes the newly closed day', async () => {
  const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-02', lane: 'swaps' }] });
  let clock = Date.parse('2026-09-02T23:59:30Z');
  let healthCalls = 0;
  const pendingOptions = [];
  const result = await ingestPoolAnalysisHistory({}, { ...f.options, rolling: true,
    now: new Date(clock), healthNow: () => new Date(clock),
    coreSnapshot: core('2026-09-02T23:59:00Z'),
    wait: async ms => { clock += ms; },
    fetchMidgard: async route => {
      assert.equal(route, '/health');
      if (++healthCalls === 1) throw Object.assign(new Error('health unavailable'), { status: 503 });
      return readyHealth(clock);
    },
    loadPendingDays: async (_client, options) => {
      pendingOptions.push(options);
      return [{ asset: ASSET, day: '2026-09-02', lane: 'swaps' }];
    },
    loadRollingEdges: async () => null, saveIntradaySnapshot: async () => {},
    loadCompletedDays: async () => [], loadBoundarySnapshots: async () => [],
    saveRollingSnapshot: async () => {}, markRollingFailure: async () => assert.fail('rolling recovery should succeed')
  });
  assert.equal(result.end_date, '2026-09-03');
  assert.equal(pendingOptions[0].today, '2026-09-03');
  assert.equal(pendingOptions[0].startDate, '2026-07-31');
  assert.equal(f.data.swaps.get('2026-09-03').partial, true);
  assert.equal(f.data.swaps.get('2026-09-03').interval_start, '2026-09-03T00:00:00.000Z');
  assert.equal(f.data.swaps.get('2026-09-02').partial, false);
  assert.equal(f.data.swaps.get('2026-09-02').completed_at, '2026-09-03T00:00:30.000Z');
  assert.equal(f.data.depth.size, 0, 'previous-day core depth cannot be labeled as current-day depth');
  assert.equal(f.states[0].stats.end_date, '2026-09-03');
});

test('steady-state refresh asks only for live swaps, reuses current core depth, and skips completed days durably', async () => {
  const f = fixture({ swaps: [swap('2026-09-01', { completed_at: NOW })],
    depths: [depth('2026-09-01', { completed_at: NOW })],
    pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' }, { asset: ASSET, day: '2026-09-01', lane: 'depth' }] });
  await ingestPoolAnalysisHistory({}, f.options);
  await ingestPoolAnalysisHistory({}, f.options);
  assert.deepEqual(f.calls, Array.from({ length: 2 }, () => ({ lane: 'swaps', asset: ASSET,
    from: '2026-09-02', through: '2026-09-02' })));
  const current = f.data.depth.get('2026-09-02');
  assert.equal(current.source, 'thornode-core:pools');
  assert.equal(current.interval_end, '2026-09-02T11:59:00.000Z');
  assert.equal(current.asset_price_usd, '10');
  assert.equal(current.partial, true);
  assert.equal(current.completed_at, null);
});

test('a newly closed partial day is sealed once, with independent per-lane completion', async () => {
  const pending = ['swaps', 'depth'].map((lane) => ({ asset: ASSET, day: '2026-09-01', lane }));
  const f = fixture({ swaps: [swap('2026-09-01', { partial: true })],
    depths: [depth('2026-09-01', { partial: true })], pending });
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.data.swaps.get('2026-09-01').completed_at, NOW);
  assert.equal(f.data.depth.get('2026-09-01').completed_at, NOW);
  f.calls.length = 0;
  await ingestPoolAnalysisHistory({}, f.options);
  assert.deepEqual(f.calls, [{ lane: 'swaps', asset: ASSET, from: '2026-09-02', through: '2026-09-02' }]);
});

test('a historical gap request cannot cross already completed days, including gaps older than the recent window', async () => {
  const f = fixture({ pending: [
    { asset: ASSET, day: '2026-06-01', lane: 'swaps' },
    { asset: ASSET, day: '2026-06-03', lane: 'swaps' }
  ] });
  await ingestPoolAnalysisHistory({}, f.options);
  assert.deepEqual(f.calls, [
    { lane: 'swaps', asset: ASSET, from: '2026-09-02', through: '2026-09-02' },
    { lane: 'swaps', asset: ASSET, from: '2026-06-01', through: '2026-06-01' },
    { lane: 'swaps', asset: ASSET, from: '2026-06-03', through: '2026-06-03' }
  ]);
});

test('closed intervals missing values or not reaching the UTC boundary remain pending', async () => {
  const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' },
    { asset: ASSET, day: '2026-09-01', lane: 'depth' }] });
  f.options.fetchSwapHistory = async (_asset, options) => ({ pages: 1,
    rows: [swap(options.startDate, { fees_rune_e8: null })] });
  f.options.fetchDepthHistory = async () => ({ pages: 1,
    rows: [depth('2026-09-01', { interval_end: '2026-09-01T23:00:00.000Z' })] });
  await ingestPoolAnalysisHistory({}, f.options);
  for (const lane of ['swaps', 'depth']) {
    assert.equal(f.data[lane].get('2026-09-01').partial, true);
    assert.equal(f.data[lane].get('2026-09-01').completed_at, null);
  }
  assert.equal(f.states[0].lastCompletedDay, null);
});

test('all swap requests failing still saves successful historical and core depth', async () => {
  const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'depth' }] });
  f.options.fetchSwapHistory = async () => { throw new Error('swaps unavailable'); };
  const result = await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(result.failed_pools, 1);
  assert.equal(f.data.depth.get('2026-09-01').completed_at, NOW);
  assert.equal(f.data.depth.get('2026-09-02').source, 'thornode-core:pools');
});

test('provider requests are bounded to the exact day and reject overshooting response rows', async () => {
  for (const fetchHistory of [fetchPoolAnalysisSwapHistory, fetchPoolAnalysisDepthHistory]) {
    const paths = [];
    const result = await fetchHistory(ASSET, { startDate: '2026-09-01', endDate: '2026-09-01', now: NOW,
      fetchMidgard: async (path) => { paths.push(path); return { intervals: ['2026-09-01', '2026-09-02'].map((day) => ({
        startTime: String(unix(day)), endTime: String(unix(nextDay(day))), totalVolume: '100', totalVolumeUSD: '200',
        totalFees: '3', runePriceUSD: '2', runeDepth: '500', assetDepth: '100', assetPriceUSD: '10'
      })) }; } });
    const url = new URL(paths[0], 'https://example.invalid');
    assert.equal(url.searchParams.get('from'), String(unix('2026-09-01')));
    assert.equal(url.searchParams.get('to'), String(unix('2026-09-02')));
    assert.equal(url.searchParams.has('count'), false);
    assert.deepEqual(result.rows.map((row) => row.day), ['2026-09-01']);
    assert.equal(result.rows[0].partial, false);
  }
});

test('today stays partial even when Midgard advertises a complete calendar bucket', async () => {
  const f = fixture();
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.data.swaps.get('2026-09-02').partial, true);
  assert.equal(f.data.swaps.get('2026-09-02').completed_at, null);
});

test('stale, cross-UTC, future, reused, or incomplete core pool fields never become current depth', async () => {
  const candidates = [
    core('2026-09-02T11:00:00.000Z'), core('2026-09-01T23:59:59.000Z'),
    core('2026-09-02T12:01:00.000Z'), { ...core(), stale: true },
    core(undefined, { field_meta: { pools: { status: 'reused', fetched_at: NOW } } }),
    core(undefined, { field_meta: {} }),
    core(undefined, { pools: [{ asset: ASSET, balance_rune: '5', balance_asset: '1' }] })
  ];
  for (const snapshot of candidates) {
    const f = fixture();
    await ingestPoolAnalysisHistory({}, { ...f.options, coreSnapshot: snapshot });
    assert.equal(f.data.depth.has('2026-09-02'), false);
    assert.match(f.states[0].lastError, /Fresh current-day core pool depth unavailable/);
    assert.equal(f.calls.filter((call) => call.lane === 'depth').length, 0);
  }
});

test('historical finality requires an in-sync aggregation watermark before same-provider history', async () => {
  const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' }] });
  const order = [];
  const configuredBase = 'https://midgard.example.invalid/v2';
  f.options.historyBase = configuredBase;
  f.options.fetchMidgard = async (path, options) => {
    order.push(path);
    assert.deepEqual(options.bases, [configuredBase]);
    return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: unix('2026-09-02') } };
  };
  f.options.fetchSwapHistory = async (_asset, options) => {
    order.push(options.startDate);
    if (options.startDate < '2026-09-02') assert.deepEqual(options.bases, [configuredBase]);
    return { pages: 1, rows: [swap(options.startDate)] };
  };
  await ingestPoolAnalysisHistory({}, f.options);
  assert.deepEqual(order, ['2026-09-02', '/health', '2026-09-01']);
  assert.equal(f.data.swaps.get('2026-09-01').completed_at, NOW);
});

test('lagging or unavailable aggregation never seals yesterday even with rounded complete bounds', async () => {
  for (const health of [
    { database: true, inSync: true, lastAggregated: { height: 1, timestamp: unix('2026-09-02') - 1 } },
    { database: true, inSync: false, lastAggregated: { height: 1, timestamp: unix('2026-09-02') } },
    { database: false, inSync: true, lastAggregated: { height: 1, timestamp: unix('2026-09-02') } }
  ]) {
    const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' }] });
    const result = await ingestPoolAnalysisHistory({}, { ...f.options, fetchMidgard: async () => health });
    assert.equal(f.data.swaps.has('2026-09-01'), false);
    assert.equal(result.historical_requests, 0);
    assert.equal(result.deferred_ranges, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.data.depth.has('2026-09-02'), true);
  }
});

test('zero-activity closed days can finish without inventing a price', async () => {
  const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' },
    { asset: ASSET, day: '2026-09-01', lane: 'depth' }] });
  f.options.fetchSwapHistory = async (_asset, options) => ({ pages: 1, rows: [swap(options.startDate, {
    volume_rune_e8: '0', volume_usd_e2: '0', fees_rune_e8: '0', rune_price_usd: null
  })] });
  f.options.fetchDepthHistory = async () => ({ pages: 1, rows: [depth('2026-09-01', {
    asset_depth_e8: '0', rune_depth_e8: '0', asset_price_usd: null
  })] });
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.data.swaps.get('2026-09-01').completed_at, NOW);
  assert.equal(f.data.swaps.get('2026-09-01').rune_price_usd, null);
  assert.equal(f.data.depth.get('2026-09-01').completed_at, NOW);
  assert.equal(f.data.depth.get('2026-09-01').asset_price_usd, null);
});

test('historical requests have a global cap and newly closed work takes priority over old gaps', async () => {
  const f = fixture({ pending: [
    { asset: ASSET, day: '2026-06-01', lane: 'swaps' },
    { asset: ASSET, day: '2026-06-03', lane: 'swaps' },
    { asset: ASSET, day: '2026-09-01', lane: 'depth' }
  ] });
  const result = await ingestPoolAnalysisHistory({}, { ...f.options, historyRequestLimit: 1 });
  assert.deepEqual(f.calls, [
    { lane: 'swaps', asset: ASSET, from: '2026-09-02', through: '2026-09-02' },
    { lane: 'depth', asset: ASSET, from: '2026-09-01', through: '2026-09-01' }
  ]);
  assert.equal(result.historical_requests, 1);
  assert.equal(result.deferred_ranges, 2);
});

test('aggregation advancing during live calls is compared with health receipt time, not run start', async () => {
  const f = fixture({ pending: [{ asset: ASSET, day: '2026-09-01', lane: 'swaps' }] });
  const result = await ingestPoolAnalysisHistory({}, { ...f.options,
    healthNow: '2026-09-02T12:02:00.000Z',
    fetchMidgard: async () => ({ database: true, inSync: true,
      lastAggregated: { height: 1, timestamp: Date.parse('2026-09-02T12:01:00Z') / 1000 } }) });
  assert.equal(result.watermark_error, '');
  assert.equal(f.data.swaps.get('2026-09-01').completed_at, NOW);
});

test('a permanently failing old gap cannot monopolize the historical request cap across runs', async () => {
  const f = fixture({ pending: [
    { asset: ASSET, day: '2026-06-01', lane: 'swaps' },
    { asset: ASSET, day: '2026-06-03', lane: 'swaps' },
    { asset: ASSET, day: '2026-06-05', lane: 'swaps' }
  ] });
  f.options.fetchSwapHistory = async (_asset, options) => {
    f.calls.push({ from: options.startDate });
    return { pages: 1, rows: [] };
  };
  for (const minute of ['00', '15', '30']) {
    await ingestPoolAnalysisHistory({}, { ...f.options, historyRequestLimit: 1,
      now: `2026-09-02T12:${minute}:00.000Z` });
  }
  assert.equal(new Set(f.calls.filter((call) => call.from < '2026-09-02').map((call) => call.from)).size, 3);
});

test('failed newly closed ranges also yield their bounded slots to other pools', async () => {
  const assets = ['BTC.BTC', 'ETH.ETH', 'LTC.LTC'];
  const f = fixture({ pending: assets.map((asset) => ({ asset, day: '2026-09-01', lane: 'swaps' })) });
  const attempted = new Set();
  f.options.fetchSwapHistory = async (asset, options) => {
    if (options.startDate < '2026-09-02') { attempted.add(asset); throw new Error('provider error'); }
    return { pages: 1, rows: [] };
  };
  for (const minute of ['00', '15', '30']) await ingestPoolAnalysisHistory({}, { ...f.options,
    assets, historyRequestLimit: 1, now: `2026-09-02T12:${minute}:00.000Z` });
  assert.equal(attempted.size, 3);
});
