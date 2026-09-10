import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DAY_SECONDS, buildFinancialsPoints, buildLiveFinancialsPoint, daySeconds } from '../../shared/financials/model.js';
import { handleFinancials } from '../src/handlers/financials.js';
import { ageFinancialsPayload } from '../src/shared/financials-read-model.js';
import { createFinancialsService } from '../src/shared/financials-service.js';
import { createFinancialsProviderRequest, publishFinancialsSnapshots, runFinancialsCollector } from '../src/jobs/financials.js';

const now = Date.parse('2026-09-10T12:00:00Z');
const today = daySeconds('2026-09-10');
const point = buildLiveFinancialsPoint({ from: today, through: today + 12 * 3600,
  swaps: { totalVolume: '100000000', totalVolumeUSD: '200' },
  earnings: { earnings: '100000000', bondingEarnings: '100000000', runePriceUSD: '2' }
});
const payload = { range: '30d', points: [point], asOf: new Date(now).toISOString(), throughDay: point.day,
  stale: false, live: { day: point.day, through: new Date(now).toISOString(), stale: false },
  bonding: { days: 0, pending: 1 }
};
const model = { key: 'financials:30d:v1', payload, generatedAt: new Date(now).toISOString(), stale: false };

test('Production Financials GET reads a bounded read-model key and never calls a provider', async () => {
  const keys = [];
  const response = await handleFinancials({}, new URL('http://localhost/financials'), {
    now: () => now,
    getReadModel: async (key) => { keys.push(key); return model; }
  });
  assert.deepEqual(keys, ['financials:30d:v1']);
  assert.equal(response.status, 200);
  assert.equal(response.body.points[0].incomeUsd, 2);
  assert.equal(response.headers['X-Boone-Read-Model-Stale'], '0');
  assert.match(response.headers['Cache-Control'], /max-age=15/);
  const invalid = await handleFinancials({}, new URL('http://localhost/financials?range=unbounded'), {
    getReadModel: () => { throw new Error('must not read'); }
  });
  assert.equal(invalid.status, 400);
  const cold = await handleFinancials({}, new URL('http://localhost/financials'), { getReadModel: async () => null });
  assert.equal(cold.status, 503);
  assert.equal(cold.headers['Retry-After'], '30');
  const source = await readFile(new URL('../src/handlers/financials.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /financials-service|fetch\(|requestFromProviders/);
});

test('GET recomputes source freshness even when a saved snapshot was initially fresh', async () => {
  const response = await handleFinancials({}, new URL('http://localhost/financials'), {
    now: () => now + 11 * 60_000, getReadModel: async () => model
  });
  assert.equal(response.body.stale, true);
  assert.equal(response.body.live.stale, true);
  assert.equal(response.headers['X-Boone-Read-Model-Stale'], '1');
});

test('A stopped publisher cannot present yesterday partial as today or as a completed day', () => {
  const completed = buildFinancialsPoints({ from: today - 29 * DAY_SECONDS, to: today });
  completed.at(-1).incomeUsd = 123;
  const aged = ageFinancialsPayload({ ...payload, points: [...completed, point] }, now + DAY_SECONDS * 1000);
  assert.equal(aged.points.length, 30);
  assert.equal(aged.points.at(-1).day, '2026-09-11');
  assert.equal(aged.points.at(-1).partial, true);
  assert.equal(aged.points.at(-1).incomeUsd, null);
  assert.equal(aged.points.find((row) => row.day === '2026-09-10').incomeUsd, null);
  assert.equal(aged.points.find((row) => row.day === '2026-09-09').incomeUsd, 123);
  assert.equal(aged.live.through, null);
  assert.equal(payload.points[0].incomeUsd, 2, 'cached input must not be mutated');
});

test('Collector snapshots are read-only and do not start provider acquisition', async () => {
  const service = createFinancialsService({ now: () => now,
    fetchImpl: () => { throw new Error('read must not fetch'); }
  });
  try {
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.points.length, 30);
    assert.equal(snapshot.stale, true);
    assert.equal(snapshot.bonding.pending, 0);
    assert.equal(snapshot.points.at(-1).partial, true);
  } finally { await service.stop(); }
});

test('Publisher persists each allowed range, coalesces unchanged snapshots, and leaves empty models untouched', async () => {
  const calls = [];
  const published = new Map();
  const service = { getSnapshot: async (range) => ({ ...payload, range }) };
  const options = { now: () => now, published, publish: async (key, body, config) => calls.push({ key, body, config }) };
  await publishFinancialsSnapshots(service, {}, options);
  await publishFinancialsSnapshots(service, {}, options);
  assert.deepEqual(calls.map(({ key }) => key), ['financials:30d:v1', 'financials:90d:v1', 'financials:1y:v1', 'financials:all:v1']);
  assert.equal(calls[0].config.sourceUpdatedAt, payload.live.through);
  assert.equal(calls[0].config.ttlMs, 120000);
  await publishFinancialsSnapshots({ getSnapshot: async (range) => ({ range, points: [{ volumeRune: null, incomeRune: null }] }) }, {}, options);
  assert.equal(calls.length, 4);
});

test('Live publication continues while historical acquisition is blocked and shutdown joins the collector', async () => {
  const abort = new AbortController();
  let releaseHistory;
  let liveRefreshes = 0;
  let stopped = 0;
  const calls = [];
  const service = {
    refreshHistory: () => new Promise((resolve) => { releaseHistory = resolve; }),
    refreshLive: async () => { liveRefreshes++; },
    getSnapshot: async (range) => ({ ...payload, range }),
    stop: async () => { stopped++; releaseHistory?.(); }
  };
  await runFinancialsCollector({ service, signal: abort.signal, lockRunner: async (_key, work) => work({}),
    publish: async (key) => { calls.push(key); abort.abort(); }
  });
  assert.ok(liveRefreshes > 0);
  assert.equal(calls.length, 4);
  assert.equal(stopped, 1);
});

test('Financials provider transport is allowlisted, bounded, and uses shared lifecycle hooks', async () => {
  let request;
  const get = createFinancialsProviderRequest({}, { transport: async (options) => { request = options; return {}; } });
  await get('https://gateway.liquify.com/chain/thorchain_midgard/v2/health', { lane: 'live' });
  assert.equal(request.timeoutMs, 60000);
  assert.equal(request.path, '/health');
  assert.equal(typeof request.beforeRequest, 'function');
  assert.equal(typeof request.onProviderError, 'function');
  assert.throws(() => get('https://untrusted.example/health'), /allowlisted/);
});

test('Production deployment installs the collector and keeps durable cache outside releases', async () => {
  const unit = await readFile(new URL('../../ops/systemd/boonetools-financials.service', import.meta.url), 'utf8');
  const deploy = await readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8');
  assert.match(unit, /StateDirectory=boonetools-financials/);
  assert.match(unit, /FINANCIALS_CACHE_DIR=\/var\/lib\/boonetools-financials/);
  assert.match(unit, /Restart=always/);
  assert.match(deploy, /if \[\[ -f "\$CURRENT_LINK\/ops\/systemd\/boonetools-financials.service" \]\]/);
  assert.match(deploy, /persistent\+=\(boonetools-financials.service\)/);
});
