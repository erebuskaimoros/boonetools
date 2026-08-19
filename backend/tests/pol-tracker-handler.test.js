import test from 'node:test';
import assert from 'node:assert/strict';

const NOW = new Date('2026-08-19T12:00:00.000Z');

test('POL Tracker handler is cache-only and supports conditional responses', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { handlePolTracker } = await import('../src/handlers/pol-tracker.js');
  const model = {
    key: 'pol-tracker:v2',
    schemaVersion: 2,
    payload: {
      as_of: NOW.toISOString(),
      daily: [{
        day: '2026-08-18',
        reserve_pol: { deployed_rune: 100, deployed_usd: 300 }
      }],
      warnings: []
    },
    etag: '"stored"',
    generatedAt: NOW.toISOString(),
    freshUntil: new Date(NOW.getTime() + 300_000).toISOString(),
    publishedAt: NOW.toISOString(),
    ageSeconds: 2,
    stale: false
  };
  const first = await handlePolTracker({ headers: {} }, null, {
    getReadModel: async () => model
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.daily[0].reserve_pol, {
    deployed_rune: 100,
    deployed_usd: 300
  });
  assert.equal(Object.hasOwn(first.body.daily[0], 'runepool'), false);
  assert.equal(first.headers['X-Boone-Cache'], 'hit');

  const second = await handlePolTracker({
    headers: { 'if-none-match': first.headers.ETag }
  }, null, { getReadModel: async () => model });
  assert.equal(second.status, 304);
  assert.equal(second.body, null);
});
test('POL Tracker handler returns a warming response instead of doing provider work', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { handlePolTracker } = await import('../src/handlers/pol-tracker.js');
  const result = await handlePolTracker({ headers: {} }, null, {
    getReadModel: async () => null
  });
  assert.equal(result.status, 503);
  assert.equal(result.headers['Retry-After'], '300');
});
