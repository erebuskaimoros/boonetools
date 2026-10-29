import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFinancialsDayDevQueue, createFinancialsDevPlugin, createFinancialsDevRequest } from '../scripts/dev-financials.mjs';
import { financialDayStatus } from '../src/lib/financials/day-status.js';

const midnight = Date.parse('2026-10-22T00:00:00Z');
function emptySource(clock, requests) {
  return async route => {
    requests.push(route);
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: Math.floor(clock() / 1000) } };
    if (route.startsWith('/history/earnings?')) {
      const params = new URL(route, 'https://example.invalid').searchParams;
      const from = Number(params.get('from'));
      const duration = params.get('interval') === 'day' ? 86400 : 300 * Number(params.get('count'));
      return { intervals: [{ startTime: from, endTime: from + duration, pools: [] }] };
    }
    assert.ok(route.startsWith('/actions?'), `Unexpected route: ${route}`);
    return { actions: [] };
  };
}

test('dev roster is inert until tick and advances without a viewer', async () => {
  let clock = midnight + 12 * 3600_000;
  const requests = [];
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: emptySource(() => clock, requests) });
  assert.equal(requests.length, 0, 'constructing the Vite plugin must not start network work');
  assert.equal(typeof queue.tick, 'function');
  await queue.tick();
  assert.equal(requests.length, 3);
  const first = queue.read('2026-10-22');
  assert.equal(first.loading, false);
  assert.equal(first.partial, true);
  clock += 2 * 3600_000;
  await queue.tick();
  assert.ok(requests.length > 3, 'an expired viewer lease does not pause a maintained roster');
  assert.ok(queue.read('2026-10-22').through > first.through);
  await queue.stop();
});

test('dev roster completes a tracked day after rollover and keeps it without reacquisition', async () => {
  let clock = midnight + 23 * 3600_000 + 45 * 60_000;
  const requests = [];
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: emptySource(() => clock, requests) });
  assert.equal(typeof queue.tick, 'function');
  await queue.tick();
  clock = midnight + 86400_000 + 20 * 60_000;
  await queue.tick();
  const complete = queue.read('2026-10-22');
  assert.equal(complete.loading, false);
  assert.equal(complete.partial, false);
  assert.equal(complete.through, '2026-10-23T00:00:00.000Z');
  const afterClosed = requests.length;
  queue.read('2026-10-22');
  await queue.idle();
  assert.equal(requests.length, afterClosed, 'closed day is never restarted by a read');
  await queue.tick();
  assert.equal(queue.read('2026-10-23').loading, false, 'new UTC day gets its own roster');
  await queue.stop();
});

test('dev roster ticks do not revive abandoned older historical scans', async () => {
  let clock = midnight + 12 * 3600_000;
  const requests = [];
  const queue = createFinancialsDayDevQueue({ now: () => clock, maxRequests: 1, requestJson: emptySource(() => clock, requests) });
  queue.read('2026-10-19');
  await queue.idle();
  assert.equal(requests.length, 1, 'test leaves a historical checkpoint unfinished');
  clock += 3 * 60_000;
  assert.equal(typeof queue.tick, 'function');
  await queue.tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1], '/health', 'tick starts today instead of resuming an expired historical viewer');
  await queue.stop();
});

test('dev roster waits for the first settled quarter-hour instead of polling an empty new day', async () => {
  let clock = midnight + 60_000;
  const requests = [];
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: emptySource(() => clock, requests) });
  await queue.tick(); queue.read('2026-10-22'); await queue.idle();
  clock = midnight + 17 * 60_000;
  await queue.tick();
  assert.equal(requests.length, 0);
  clock = midnight + 18 * 60_000;
  await queue.tick();
  assert.equal(requests.length, 3);
  assert.equal(queue.read('2026-10-22').through, '2026-10-22T00:15:00.000Z');
  await queue.stop();
});

test('dev roster caps every tick at ten acquisition steps and resumes the saved cursor', async () => {
  let clock = midnight + 12 * 3600_000, pages = 0;
  const requests = [];
  const base = emptySource(() => clock, requests);
  const queue = createFinancialsDayDevQueue({ now: () => clock, maxRequests: 100, requestJson: async route => {
    if (!route.startsWith('/actions?')) return base(route);
    requests.push(route); pages++;
    return { actions: [{ type: 'swap', status: 'pending', date: String(BigInt(midnight / 1000 + 1) * 1000000000n),
      in: [{ txID: `PENDING-${pages}` }], pools: [] }], meta: { nextPageToken: `page-${pages}` } };
  } });
  await queue.tick();
  assert.equal(requests.length, 10);
  assert.equal(pages, 8);
  clock += 5001;
  await queue.tick();
  assert.equal(requests.length, 20);
  assert.match(requests[10], /nextPageToken=page-8/);
  assert.equal(requests.filter(route => route === '/health').length, 1);
  await queue.stop();
});

test('dev roster scheduling is bounded, idempotent, and stops without new work', async () => {
  const requests = [], timers = new Map(), cleared = [];
  let handle = 0;
  const queue = createFinancialsDayDevQueue({ now: () => midnight + 12 * 3600_000,
    requestJson: emptySource(() => midnight + 12 * 3600_000, requests),
    setTimer: (callback, delay) => { const id = ++handle; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => { cleared.push(id); timers.delete(id); } });
  assert.equal(typeof queue.start, 'function');
  queue.start(); queue.start();
  assert.equal(timers.size, 1);
  const first = [...timers.values()][0]; timers.clear();
  assert.equal(first.delay, 0);
  await first.callback();
  assert.equal(timers.size, 1);
  assert.ok([...timers.values()][0].delay >= 1000, 'continuation is paced, never a hot loop');
  await queue.stop();
  assert.equal(timers.size, 0);
  assert.ok(cleared.length);
  const stoppedCalls = requests.length;
  await queue.tick(); queue.read('2026-10-20'); await queue.idle();
  assert.equal(requests.length, stoppedCalls);
});

test('dev roster promotes an unfinished yesterday without resetting its provider cooldown', async () => {
  let clock = midnight + 12 * 3600_000, requests = 0;
  const retryAt = new Date(clock + 3600_000).toISOString();
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: async () => {
    requests++;
    throw Object.assign(new Error('Budget deferred'), { retryAt });
  } });
  queue.read('2026-10-21'); await queue.idle();
  clock += 3 * 60_000;
  assert.equal(typeof queue.tick, 'function');
  await queue.tick();
  assert.equal(requests, 2, 'only newly tracked today is attempted before yesterday’s cooldown ends');
  assert.equal(queue.read('2026-10-21').retryAt, retryAt);
  clock += 3600_000;
  await queue.tick();
  assert.equal(requests, 3, 'promoted yesterday resumes without a recent viewer lease');
  await queue.stop();
});

test('dev roster stop aborts the in-flight provider request without starting another', async () => {
  let requests = 0, acquiredSignal;
  const queue = createFinancialsDayDevQueue({ now: () => midnight + 12 * 3600_000,
    requestJson: async (_route, { signal }) => {
      requests++; acquiredSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  queue.read('2026-10-19');
  assert.equal(requests, 1);
  await queue.stop();
  assert.equal(acquiredSignal.aborted, true);
  assert.equal(requests, 1);
});

test('dev provider transport receives cancellation and rejects before charging an aborted request', async () => {
  const controller = new AbortController();
  let budgets = 0, requests = 0;
  const request = createFinancialsDevRequest(async options => {
    requests++; assert.equal(options.request.signal, controller.signal); return {};
  }, { budget: () => budgets++ });
  await request('/health', { signal: controller.signal });
  controller.abort();
  assert.throws(() => request('/health', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(budgets, 1); assert.equal(requests, 1);
});

test('dev roster plugin starts only when the Vite server is configured and stops on close', async t => {
  let starts = 0, stops = 0, serviceStops = 0;
  const events = new Map();
  // A throwaway checkout root keeps the plugin's cache migration away from real dev data.
  const root = await mkdtemp(path.join(tmpdir(), 'boonetools-dev-roster-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = createFinancialsDevPlugin({
    root,
    days: { start: () => starts++, stop: async () => stops++ },
    createService: () => ({ stop: async () => serviceStops++ })
  });
  assert.equal(starts, 0);
  await plugin.configureServer({ middlewares: { use() {} }, httpServer: { once: (event, callback) => events.set(event, callback) } });
  assert.equal(starts, 1);
  assert.equal(typeof events.get('close'), 'function');
  await events.get('close')();
  await plugin.closeBundle();
  assert.equal(stops, 1);
  assert.equal(serviceStops, 1);
});

test('day detail explains maintained rosters without promising instant cold history or financial finality', () => {
  const source = readFileSync(new URL('../src/lib/financials/DayDetail.svelte', import.meta.url), 'utf8');
  assert.match(source, /Today’s roster adds newly indexed activity in the background/);
  assert.match(source, /cached after the full local day is covered/);
  assert.match(source, /Older, untracked days may need a one-time build/);
  assert.doesNotMatch(source, /Today adds newly indexed activity while this panel is open|leaving pauses unfinished scans/);
  assert.doesNotMatch(source, /Late settlements are not automatically rescanned/);
  assert.match(source, /financialDayStatus\(detail\)/);
  assert.match(source, /\{dayStatus.warning\}/);
  assert.match(source, /\{dayStatus.settlement\}/);
  const { warning, settlement } = financialDayStatus({ pendingSwaps: 1, settlement: { status: 'pending' } });
  assert.match(warning, /Provisional snapshot/);
  assert.match(warning, /saved Midgard status/);
  assert.match(settlement, /Only saved pending IDs are rechecked; the day is not rescanned/);
});
