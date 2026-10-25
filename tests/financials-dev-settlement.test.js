import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialsDayDevQueue } from '../scripts/dev-financials.mjs';

const day = '2026-10-22';
const from = Date.parse(`${day}T00:00:00Z`) / 1000;
const now = Date.parse('2026-10-24T12:00:00Z');
const action = (txId, status = 'pending') => ({ type: 'swap', status, date: String(BigInt(from + 10) * 1000000000n),
  in: [{ txID: txId, coins: [{ asset: 'BTC.BTC', amount: '100000000' }] }],
  out: [{ coins: [{ asset: 'ETH.ETH', amount: '100000000' }] }], metadata: { swap: { inPriceUSD: '60000' } } });

function source(ids, routes, lookup) {
  return async route => {
    routes.push(route);
    const url = new URL(route, 'https://example.invalid');
    if (url.searchParams.has('txid')) return lookup(url.searchParams.get('txid'));
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: from + 86400 } };
    if (url.pathname === '/history/earnings') return { intervals: [{ startTime: from, endTime: from + 86400, pools: [] }] };
    return { actions: [...ids.map(id => action(id)), { ...action('OLD'), date: String(BigInt(from - 1) * 1000000000n) }] };
  };
}

test('dev closed-day IDs reconcile without a viewer and fully resolved rankings stop requesting forever', async () => {
  let clock = now, success = false;
  const routes = [];
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: source(['PENDING'], routes,
    id => ({ actions: [action(id, success ? 'success' : 'pending')] })) });
  queue.read(day); await queue.idle();
  const first = queue.read(day);
  assert.equal(first.settlement.status, 'pending');
  assert.equal(first.settlement.passCount, 1);
  assert.equal(routes.length, 4);
  assert.equal(first.refreshing, false);
  clock += 3600_000; success = true;
  await queue.tick();
  const settled = queue.read(day);
  assert.equal(settled.pendingSwaps, 0);
  assert.equal(settled.settlement.status, 'complete');
  assert.equal(settled.swaps[0].txId, 'PENDING');
  assert.equal(routes.length, 5);
  assert.match(routes[4], /[?&]txid=PENDING(?:&|$)/);
  clock += 30 * 86400_000;
  queue.read(day); await queue.idle();
  assert.equal(routes.length, 5, 'reads of a settled old day never request either acquisition or settlement');
  assert.equal(queue.read(day).finalized, true);
  await queue.stop();
});

test('dev targeted lookups stay under the ten-step batch cap and resume the next saved ID', async () => {
  let clock = now;
  const routes = [], ids = Array.from({ length: 25 }, (_, index) => `ID-${index}`);
  const queue = createFinancialsDayDevQueue({ now: () => clock, maxRequests: 100,
    requestJson: source(ids, routes, id => ({ actions: [action(id)] })) });
  queue.read(day); await queue.idle();
  const firstIds = routes.filter(route => route.includes('txid=')).map(route => new URL(route, 'https://example.invalid').searchParams.get('txid'));
  assert.deepEqual(firstIds, ids.slice(0, 6), 'initial ten steps include health, earnings, actions and the empty pool completion');
  clock += 5001;
  queue.read(day); await queue.idle();
  const nextIds = routes.filter(route => route.includes('txid=')).map(route => new URL(route, 'https://example.invalid').searchParams.get('txid'));
  assert.deepEqual(nextIds, ids.slice(0, 16));
  assert.equal(queue.read(day).settlement.checkedAt, null, 'partial passes do not claim all IDs were checked');
  assert.equal(routes.filter(route => route === '/health').length, 1);
  await queue.stop();
});

test('dev settlement failures preserve cursor and provider cooldown instead of repeating prior IDs', async () => {
  let clock = now, blocked = true;
  const routes = [], retryAt = new Date(now + 4 * 3600_000).toISOString();
  const queue = createFinancialsDayDevQueue({ now: () => clock,
    requestJson: source(['A', 'B', 'C'], routes, id => {
      if (id === 'B' && blocked) throw Object.assign(new Error('Budget deferred'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt });
      return { actions: [action(id, 'success')] };
    }) });
  queue.read(day); await queue.idle();
  const deferred = queue.read(day);
  assert.equal(deferred.settlement.status, 'pending');
  assert.equal(deferred.pendingSwaps, 2);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.settlement.nextCheckAt, retryAt);
  assert.equal(deferred.refreshing, false);
  clock += 3600_000;
  queue.read(day); await queue.idle();
  assert.equal(routes.filter(route => route.includes('txid=')).length, 2);
  clock = Date.parse(retryAt); blocked = false;
  queue.read(day); await queue.idle();
  assert.deepEqual(routes.filter(route => route.includes('txid=')).map(route => new URL(route, 'https://example.invalid').searchParams.get('txid')), ['A', 'B', 'B', 'C']);
  assert.equal(queue.read(day).settlement.status, 'complete');
  await queue.stop();
});
