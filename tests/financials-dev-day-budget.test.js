import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialsDevBudget, createFinancialsDevRequest, createFinancialsDayDevQueue } from '../scripts/dev-financials.mjs';

const day = '2026-10-12', from = Date.parse(`${day}T00:00:00Z`) / 1000, to = from + 86400;
const now = (to + 3 * 86400) * 1000;
const base = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
const pendingAction = { type: 'swap', status: 'pending', date: String(BigInt(from + 1) * 1000000000n),
  in: [{ txID: 'PENDING', coins: [{ asset: 'BTC.BTC', amount: '1000' }] }], pools: [] };

test('dev bulk requests share a bounded budget with history while reserving aggregate capacity', async () => {
  let clock = now, calls = 0;
  const budget = createFinancialsDevBudget({ now: () => clock });
  const transport = async options => { calls++; assert.equal(options.providerMinIntervalMs, 1000); return {}; };
  const bulk = createFinancialsDevRequest(transport, { budget, bulk: true });
  const history = createFinancialsDevRequest(transport, { budget });
  for (let index = 0; index < 30; index++) await bulk(`${base}/health`);
  assert.throws(() => bulk(`${base}/health`), error => error.code === 'MIDGARD_BUDGET_DEFERRED'
    && error.budgetReason === 'bulk-minute' && Date.parse(error.retryAt) > clock);
  assert.throws(() => history(`${base}/actions?limit=50`), /budget reached/, 'actions remain bulk even when caller omits the class');
  assert.equal(calls, 30);
  for (let index = 0; index < 30; index++) await history(`${base}/history/earnings`);
  assert.throws(() => history(`${base}/health`), error => error.budgetReason === 'total-minute');
  assert.equal(calls, 60);
  clock += 60_000;
  await bulk(`${base}/health`); assert.equal(calls, 61);
});

test('dev queue never reacquires a completed historical snapshot with pending exclusions', async () => {
  let clock = now, calls = 0;
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: async url => {
    calls++;
    if (url.endsWith('/health')) return { inSync: true, lastAggregated: { timestamp: to } };
    if (url.includes('/history/earnings')) return { intervals: [{ startTime: from, endTime: to, pools: [] }] };
    return { actions: [pendingAction, { ...pendingAction, date: String(BigInt(from - 1) * 1000000000n) }] };
  } });
  assert.equal(queue.read(day).loading, true);
  await queue.idle();
  const first = queue.read(day);
  assert.equal(first.pendingSwaps, 1); assert.equal(first.finalized, false); assert.equal(first.loading, false);
  assert.equal(calls, 3);
  clock += 3600_000;
  assert.equal(queue.read(day).refreshing, false);
  await queue.idle(); assert.equal(calls, 3);
  await queue.stop();
});

test('dev queue stops abandoned batches after its short lease and resumes the exact checkpoint on a new read', async () => {
  let clock = now, calls = 0;
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: async url => {
    calls++;
    if (url.endsWith('/health')) { clock += 120_001; return { inSync: true, lastAggregated: { timestamp: to } }; }
    if (url.includes('/history/earnings')) return { intervals: [{ startTime: from, endTime: to, pools: [] }] };
    assert.ok(url.includes('/actions')); return { actions: [] };
  } });
  queue.read(day); await queue.idle(); assert.equal(calls, 1);
  assert.equal(queue.read(day).progress.phase, 'earnings');
  clock += 5001;
  queue.read(day); await queue.idle(); assert.equal(calls, 3, 'resumes earnings and actions without another health request');
  assert.equal(queue.read(day).loading, false);
  await queue.stop();
});

test('dev queue exposes and honors budget retry time without repeated provider attempts', async () => {
  let clock = now, calls = 0;
  const retryAt = new Date(now + 4 * 3600_000).toISOString();
  const queue = createFinancialsDayDevQueue({ now: () => clock, requestJson: async () => {
    calls++; throw Object.assign(new Error('Budget deferred'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt });
  } });
  queue.read(day); await queue.idle();
  const result = queue.read(day);
  assert.equal(result.deferred, true); assert.equal(result.retryAt, retryAt); assert.equal(calls, 1);
  clock += 3600_000;
  queue.read(day); await queue.idle(); assert.equal(calls, 1);
  clock += 3 * 3600_000;
  queue.read(day); await queue.idle(); assert.equal(calls, 2);
  await queue.stop();
});
