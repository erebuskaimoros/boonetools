import test from 'node:test';
import assert from 'node:assert/strict';
import { runVisitorDataScheduler } from '../src/jobs/visitor-data.js';

test('first-run global acquisition failure makes the worker fail after committing successful work', async () => {
  let affiliateRan = false;
  await assert.rejects(runVisitorDataScheduler({
    lockRunner: async (_key, run) => run({ query: async () => ({ rows: [] }) }),
    refreshSnapshots: async () => ({ errors: ['provider unavailable'] }),
    refreshAffiliates: async () => { affiliateRan = true; return { errors: [] }; },
    loadSnapshot: async () => null
  }), /warmup incomplete/);
  assert.equal(affiliateRan, true);
});

test('last-good global snapshots keep the worker usable during history source failures', async () => {
  const result = await runVisitorDataScheduler({
    lockRunner: async (_key, run) => run({ query: async () => ({ rows: [] }) }),
    refreshSnapshots: async () => ({ errors: [] }),
    refreshAffiliates: async () => ({ errors: ['history source unavailable'] }),
    loadSnapshot: async () => ({ payload: {}, stale: true })
  });
  assert.equal(result.affiliates.errors.length, 1);
});

test('the stable swap backfill runs last with a one-page budget and its failures never fail the job', async () => {
  const order = [];
  const logs = [];
  const base = {
    lockRunner: async (_key, run) => run({ query: async () => ({ rows: [] }) }),
    refreshSnapshots: async () => { order.push('snapshots'); return { errors: [] }; },
    refreshAffiliates: async () => { order.push('affiliates'); return { errors: [] }; },
    loadSnapshot: async () => ({ payload: {} }),
    log: (line) => logs.push(line)
  };
  const recorded = await runVisitorDataScheduler({ ...base,
    advanceStableSwapBackfill: async (_client, options) => {
      order.push(`backfill:${options.maxPages}`);
      return { status: 'scanning', pages: 1, days_completed: 0, swaps: 0, error: 'Midgard request deferred by shared budget' };
    } });
  assert.deepEqual(order, ['snapshots', 'affiliates', 'backfill:1']);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.stableSwaps.error, 'Midgard request deferred by shared budget');
  assert.match(logs[0], /deferred/);

  const thrown = await runVisitorDataScheduler({ ...base,
    advanceStableSwapBackfill: async () => { throw new Error('connection reset'); } });
  assert.equal(thrown.ok, true);
  assert.deepEqual(thrown.stableSwaps, { status: 'error', pages: 0, days_completed: 0, swaps: 0, error: 'connection reset' });
  assert.deepEqual(order.slice(3), ['snapshots', 'affiliates'], 'affiliates and snapshots still ran');
});
