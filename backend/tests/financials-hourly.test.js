import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFinancialsHourlyService } from '../src/shared/financials-hourly.js';
import { handleFinancials } from '../src/handlers/financials.js';
import { publishFinancialHourlySnapshot } from '../src/jobs/financials.js';
import { FINANCIALS_HOURLY_MODEL_KEY, financialHourlyWindow, sliceFinancialHourlyPayload } from '../../shared/financials/hourly.js';

const now = Date.parse('2026-10-25T05:17:00Z');
function fixture(clock, routes, { wrongRange = false, failure = null } = {}) {
  return async (route, options) => {
    routes.push(route);
    assert.equal(options.service, 'midgard', 'hourly never requests RPC/bond snapshots');
    if (failure) throw failure;
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: clock() / 1000 - 60 } };
    const url = new URL(route, 'https://fixture.invalid');
    const step = url.searchParams.get('interval') === 'hour' ? 3600 : 300;
    const from = Number(url.searchParams.get('from')) + (wrongRange ? 3600 : 0);
    return { intervals: Array.from({ length: Number(url.searchParams.get('count')) }, (_, index) => ({
      startTime: String(from + index * step), endTime: String(from + (index + 1) * step),
      totalVolume: '200000000', totalVolumeUSD: '100', earnings: '100000000',
      liquidityFees: '80000000', blockRewards: '-20000000', bondingEarnings: '50000000', runePriceUSD: '0.5',
      pools: [{ asset: 'discard bulky attribution' }]
    })) };
  };
}

test('hourly collector prioritizes 24 buckets, uses bounded fills and never fetches bonds', async () => {
  const routes = [], service = createFinancialsHourlyService({ now: () => now, requestJson: fixture(() => now, routes) });
  try {
    await Promise.all([service.refresh(), service.refresh()]);
    const result = await service.getSnapshot();
    assert.equal(result.points.length, 24);
    assert.equal(result.points[0].day, '2026-10-24T06:00:00.000Z');
    assert.equal(result.points.at(-1).day, '2026-10-25T05:00:00.000Z');
    assert.equal(result.points[0].volumeUsd, 1);
    assert.equal(result.points[0].incomeUsd, 0.5);
    assert.equal(result.points.at(-1).incomeUsd, 1.5, 'three completed five-minute intervals');
    assert.equal(result.points.at(-1).partial, true);
    assert.equal(result.live.through, '2026-10-25T05:15:00.000Z');
    assert.equal(result.stale, false);
    assert.equal(result.points[0].bondingApr, undefined);
    assert.match(routes[1], /interval=hour.*count=23/);
    assert.ok(routes.filter(route => route.includes('interval=hour')).every(route => Number(new URL(route, 'https://fixture.invalid').searchParams.get('count')) <= 120));
    const count = routes.length; await service.refresh(); assert.equal(routes.length, count, 'coalesced cached refresh');
    const all = await service.getSnapshot('30d'); assert.equal(all.points.length, 720);
    assert.equal(all.points[0].volumeUsd, null, 'unacquired history remains a gap');
  } finally { await service.stop(); }
});

test('completed hourly observations survive restart and full cache refresh only revisits recent hours', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'financial-hour-'));
  let clock = now;
  const routes = [];
  let service = createFinancialsHourlyService({ cacheDir, now: () => clock, requestJson: fixture(() => clock, routes) });
  try {
    for (let pass = 0; pass < 7; pass++) { await service.refresh(); clock += 60_000; }
    assert.equal((await service.getSnapshot('30d')).points.filter(point => point.volumeUsd !== null).length, 720);
    await service.stop();
    routes.length = 0;
    service = createFinancialsHourlyService({ cacheDir, now: () => clock, requestJson: fixture(() => clock, routes) });
    assert.equal((await service.getSnapshot()).points[0].volumeUsd, 1);
    await service.refresh();
    assert.ok(routes.filter(route => route.includes('interval=hour')).every(route => Number(new URL(route, 'https://fixture.invalid').searchParams.get('count')) <= 2));
  } finally { await service.stop(); await rm(cacheDir, { recursive: true, force: true }); }
});

test('provider deferral preserves last good hours and retry timing without retry storms', async () => {
  let clock = now, fail = false;
  const routes = [], good = fixture(() => clock, routes), retry = now + 3600_000;
  const service = createFinancialsHourlyService({ now: () => clock, requestJson: async (...args) => {
    if (fail) { routes.push('blocked'); throw Object.assign(new Error('budget deferred'), { retryAt: new Date(retry).toISOString() }); }
    return good(...args);
  } });
  try {
    await service.refresh(); fail = true; clock += 60_000; await service.refresh();
    const count = routes.length; clock += 60_000; await service.refresh(); assert.equal(routes.length, count);
    const snapshot = await service.getSnapshot(); assert.equal(snapshot.points[0].volumeUsd, 1); assert.equal(snapshot.stale, true);
    assert.match(snapshot.error, /budget deferred/);
  } finally { await service.stop(); }
});

test('wrong provider windows are rejected and never cached as requested hours', async () => {
  const service = createFinancialsHourlyService({ now: () => now, requestJson: fixture(() => now, [], { wrongRange: true }) });
  try { await service.refresh(); const result = await service.getSnapshot();
    assert.ok(result.points.every(point => point.volumeUsd === null)); assert.match(result.error, /Incomplete hourly/);
  } finally { await service.stop(); }
});

test('hourly read models age across midnight, keeping gaps instead of promoting partial hours', async () => {
  const service = createFinancialsHourlyService({ now: () => now, requestJson: fixture(() => now, []) });
  try {
    await service.refresh(); const payload = await service.getSnapshot('30d');
    const aged = sliceFinancialHourlyPayload(payload, '24h', now + 3600_000);
    assert.equal(aged.points.length, 24); assert.equal(aged.stale, true);
    assert.equal(aged.points.at(-2).incomeUsd, null); assert.equal(aged.points.at(-2).partial, false);
    assert.equal(aged.points.at(-1).partial, true);
    const keys = [];
    const response = await handleFinancials({}, new URL('https://fixture.invalid/financials?bucket=hour&range=7d'), {
      now: () => now, getReadModel: async key => { keys.push(key); return { payload }; }
    });
    assert.equal(response.status, 200); assert.equal(response.body.points.length, 168);
    assert.deepEqual(keys, [FINANCIALS_HOURLY_MODEL_KEY]);
    const invalid = await handleFinancials({}, new URL('https://fixture.invalid/financials?bucket=hour&range=all'), {
      getReadModel: () => { throw new Error('must not read'); }
    });
    assert.equal(invalid.status, 400);
    assert.throws(() => financialHourlyWindow('1y'), /Hourly range/);
  } finally { await service.stop(); }
});

test('hourly publication reads saved points independently of a pending older-history request', async () => {
  let unblock, announce;
  const blocked = new Promise(resolve => announce = resolve), wait = new Promise(resolve => unblock = resolve);
  const routes = [], good = fixture(() => now, routes);
  const service = createFinancialsHourlyService({ now: () => now, requestJson: async (route, options) => {
    if (route.includes('count=120')) { announce(); await wait; }
    return good(route, options);
  } });
  const active = service.refresh();
  try {
    await blocked;
    const writes = [], published = new Map();
    const options = { now: () => now, published, publish: async (key, payload) => writes.push({ key, payload }) };
    await publishFinancialHourlySnapshot(service, {}, options);
    await publishFinancialHourlySnapshot(service, {}, options);
    assert.equal(writes.length, 1, 'unchanged payload coalesces');
    assert.equal(writes[0].key, FINANCIALS_HOURLY_MODEL_KEY);
    assert.equal(writes[0].payload.points.filter(point => point.volumeUsd !== null).length, 24);
    assert.equal(writes[0].payload.points.at(-1).partial, true);
  } finally { unblock(); await active; await service.stop(); }
});
