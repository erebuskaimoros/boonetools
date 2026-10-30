import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFinancialsDayDevQueue, createFinancialsDevPlugin } from '../scripts/dev-financials.mjs';

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
