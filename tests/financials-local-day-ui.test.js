import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFinancialsDayDevQueue, createFinancialsDevPlugin } from '../scripts/dev-financials.mjs';
import { financialDetailPicker, selectFinancialDetailDay } from '../src/lib/financials/day-selection.js';
import { fetchFinancialDay } from '../src/lib/financials/api.js';

test('local picker accepts dates east of UTC and rejects tomorrow west of UTC independently of plotted days', () => {
  const now = Date.parse('2026-10-29T01:00:00Z');
  const west = { now, timeZone: 'America/New_York' };
  assert.equal(financialDetailPicker(west).max, '2026-10-28');
  assert.equal(selectFinancialDetailDay('2026-10-28', west), '2026-10-28');
  assert.equal(selectFinancialDetailDay('2026-10-29', west), '');
  const east = { now: Date.parse('2026-10-29T12:00:00Z'), timeZone: 'Pacific/Kiritimati' };
  assert.equal(financialDetailPicker(east).max, '2026-10-30');
  assert.equal(selectFinancialDetailDay('2026-10-30', east), '2026-10-30');
  assert.equal(selectFinancialDetailDay('2026-02-30', east), '');
  assert.equal(selectFinancialDetailDay('2021-04-12', east), '');
});

test('frontend day request includes the selected browser timezone', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(new URL(url, 'https://example.test'));
    return { ok: true, headers: new Headers(), json: async () => ({ day: '2026-10-29' }) };
  });
  await fetchFinancialDay('2026-10-29', { timeZone: 'America/New_York' });
  assert.equal(urls[0].searchParams.get('day'), '2026-10-29');
  assert.equal(urls[0].searchParams.get('timeZone'), 'America/New_York');
});

test('dev day cache isolates local and UTC windows for the same calendar date', async t => {
  const now = Date.parse('2026-11-03T12:00:00Z'), calls = [];
  const queue = createFinancialsDayDevQueue({ now: () => now, requestJson: async route => {
    calls.push(route);
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: now / 1000 } };
    const query = new URL(route, 'https://example.test').searchParams;
    if (route.startsWith('/history/earnings')) {
      const from = Number(query.get('from'));
      const duration = query.get('interval') === 'day' ? 86400 : 300 * Number(query.get('count'));
      return { intervals: [{ startTime: from, endTime: from + duration, pools: [] }] };
    }
    return { actions: [] };
  } });
  t.after(() => queue.stop());
  queue.read('2026-10-29', 'UTC');
  await queue.idle();
  assert.equal(queue.read('2026-10-29', 'UTC').loading, false);
  const initial = queue.read('2026-10-29', 'America/New_York');
  assert.equal(initial.loading, true, 'a UTC cache entry must not be served for a local calendar day');
  await queue.idle();
  const local = queue.read('2026-10-29', 'America/New_York');
  assert.equal(local.timeZone, 'America/New_York');
  assert.equal(local.windowFrom, '2026-10-29T04:00:00.000Z');
  assert.equal(local.windowTo, '2026-10-30T04:00:00.000Z');
  assert.equal(local.through, local.windowTo);
  assert.equal(calls.filter(route => route === '/health').length, 2);
});

test('dev ranks non-RUNE swaps by priced fees over the full 25-hour local day', async t => {
  const from = Date.parse('2026-11-01T04:00:00Z') / 1000, to = Date.parse('2026-11-02T05:00:00Z') / 1000;
  const now = Date.parse('2026-11-03T12:00:00Z');
  const action = (txId, at, amount, liquidityFee) => ({ type: 'swap', status: 'success',
    date: String(BigInt(at) * 1000000000n), in: [{ txID: txId, coins: [{ asset: 'BTC.BTC', amount }] }],
    out: [{ coins: [{ asset: 'ETH.ETH', amount: '100000000' }] }],
    metadata: { swap: { inPriceUSD: '60000', liquidityFee } } });
  const queue = createFinancialsDayDevQueue({ now: () => now, requestJson: async route => {
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: to } };
    if (route.startsWith('/history/earnings')) {
      const params = new URL(route, 'https://example.test').searchParams;
      assert.equal(params.get('from'), String(from));
      assert.equal(params.get('interval'), '5min');
      assert.equal(params.get('count'), '300');
      return { intervals: [{ startTime: from, endTime: to, pools: [], runePriceUSD: '0.5' }] };
    }
    return { actions: [action('MIDNIGHT-NEXT-DAY', to, '100000000', '99900000000'),
      action('SMALL-HIGH-FEE', to - 1, '1000000', '10000000000'),
      action('LARGE-LOW-FEE', from + 1, '100000000', '100000000'),
      action('PREVIOUS-DAY', from - 1, '100000000', '99900000000')] };
  } });
  t.after(() => queue.stop());
  queue.read('2026-11-01', 'America/New_York'); await queue.idle();
  const detail = queue.read('2026-11-01', 'America/New_York');
  assert.equal(detail.partial, false);
  assert.deepEqual(detail.swaps.map(row => [row.txId, row.feeUsd]), [['SMALL-HIGH-FEE', 50], ['LARGE-LOW-FEE', 0.5]]);
  assert.equal(detail.windowFrom, '2026-11-01T04:00:00.000Z');
  assert.equal(detail.windowTo, '2026-11-02T05:00:00.000Z');
});

test('dev endpoint forwards the timezone and rejects an invalid zone before queue access', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'financials-local-day-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reads = []; let middleware;
  const plugin = createFinancialsDevPlugin({ root,
    days: { start() {}, async stop() {}, read(day, timeZone) { reads.push({ day, timeZone }); return { day, timeZone }; } },
    createService: () => ({ async stop() {} }), createHourlyService: () => ({ async stop() {} }) });
  t.after(() => plugin.closeBundle());
  await plugin.configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  const request = async url => {
    const response = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await middleware({ url, method: 'GET' }, response, () => assert.fail('wrong route'));
    return response;
  };
  const response = await request('/__financials?day=2026-10-29&timeZone=America%2FNew_York');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(reads, [{ day: '2026-10-29', timeZone: 'America/New_York' }]);
  const invalid = await request('/__financials?day=2026-10-29&timeZone=Invalid%2FZone');
  assert.equal(invalid.statusCode, 400);
  assert.equal(reads.length, 1);
});
