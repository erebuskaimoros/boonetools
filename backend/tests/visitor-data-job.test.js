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
