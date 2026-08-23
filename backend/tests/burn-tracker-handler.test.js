import test from 'node:test';
import assert from 'node:assert/strict';

test('Burn Tracker handler overlays exact post-snapshot blocks and supports conditional responses', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { handleBurnTracker } = await import('../src/handlers/burn-tracker.js');
  const model = {
    key: 'system-income-burn:v1',
    schemaVersion: 1,
    payload: {
      as_of: '2024-09-26T12:00:00Z',
      summary: { total_burned_e8: '35', current_supply_e8: '100', burn_rate_bps: 500 },
      daily: [{ day: '2024-09-26', burn_e8: '35', cumulative_burn_e8: '35' }],
      warnings: []
    },
    etag: 'stored',
    generatedAt: '2024-09-26T12:00:00Z',
    publishedAt: '2024-09-26T12:00:00Z',
    ageSeconds: 2,
    stale: false
  };
  const getLiveOverlay = async () => ({
    days: [{ day: '2024-09-26', burn_e8: '5' }],
    through_height: 123,
    through_time: '2024-09-26T12:00:06Z'
  });
  const first = await handleBurnTracker({ headers: {} }, null, {
    getReadModel: async () => model,
    getLiveOverlay
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.summary.total_burned_e8, '40');
  assert.equal(first.body.summary.current_supply_e8, '95');
  assert.equal(first.body.daily[0].burn_e8, '40');
  assert.equal(first.body.live.through_height, 123);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.equal(first.headers['X-Boone-Cache'], 'live-overlay');

  const second = await handleBurnTracker({
    headers: { 'if-none-match': first.headers.ETag }
  }, null, { getReadModel: async () => model, getLiveOverlay });
  assert.equal(second.status, 304);
  assert.equal(second.body, null);
});

test('Burn Tracker handler returns a warming response when no read model exists', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { handleBurnTracker } = await import('../src/handlers/burn-tracker.js');
  const result = await handleBurnTracker({ headers: {} }, null, {
    getReadModel: async () => null
  });
  assert.equal(result.status, 503);
  assert.equal(result.headers['Retry-After'], '300');
});
