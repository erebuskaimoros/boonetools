import test from 'node:test';
import assert from 'node:assert/strict';

const NOW = new Date('2026-07-18T12:00:00.000Z');

test('Treasury snapshot handler is cache-only and supports conditional responses', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { handleTreasurySnapshot } = await import('../src/handlers/treasury-snapshot.js');
  const model = {
    key: 'treasury-snapshot:v1',
    schemaVersion: 1,
    payload: { as_of: NOW.toISOString(), sections: [], control: { private: true } },
    etag: '"stored"',
    generatedAt: NOW.toISOString(),
    freshUntil: new Date(NOW.getTime() + 300_000).toISOString(),
    publishedAt: NOW.toISOString(),
    ageSeconds: 2,
    stale: false
  };
  const first = await handleTreasurySnapshot({ headers: {} }, null, {
    getReadModel: async () => model
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.control, undefined);
  assert.equal(first.headers['X-Boone-Cache'], 'hit');

  const second = await handleTreasurySnapshot({
    headers: { 'if-none-match': first.headers.ETag }
  }, null, { getReadModel: async () => model });
  assert.equal(second.status, 304);
  assert.equal(second.body, null);
});
