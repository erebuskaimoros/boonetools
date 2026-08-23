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

test('POL Tracker handler marks a recently republished source-day lag stale', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { handlePolTracker } = await import('../src/handlers/pol-tracker.js');
  const result = await handlePolTracker({ headers: {} }, null, {
    now: new Date('2026-08-21T12:00:00.000Z'),
    getReadModel: async () => ({
      key: 'pol-tracker:v2',
      schemaVersion: 2,
      payload: {
        end_date: '2026-08-18',
        latest: {
          day: '2026-08-18',
          block_time: '2026-08-18T23:59:58.247Z',
          complete: true
        },
        coverage: {
          expected_days: 564,
          observed_days: 564,
          complete_days: 564,
          partial_days: 0,
          missing_days: 0,
          last_day: '2026-08-18'
        },
        daily: [],
        warnings: []
      },
      etag: 'stored',
      generatedAt: '2026-08-20T19:12:52.518Z',
      sourceUpdatedAt: '2026-08-18T23:59:58.247Z',
      freshUntil: '2026-08-22T07:12:52.518Z',
      publishedAt: '2026-08-20T19:12:52.570Z',
      ageSeconds: 60_000,
      stale: false
    })
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.stale, true);
  assert.equal(result.body.target_end_date, '2026-08-20');
  assert.equal(result.body.coverage.expected_days, 566);
  assert.equal(result.body.coverage.observed_days, 564);
  assert.equal(result.body.coverage.missing_days, 2);
  assert.match(result.body.warnings.join(' '), /source is 2 days behind/i);
  assert.equal(result.body.read_model.stale, true);
  assert.equal(result.headers['X-Boone-Cache'], 'stale');
});
