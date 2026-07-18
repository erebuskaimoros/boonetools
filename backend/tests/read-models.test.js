import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAndPublishReadModel,
  clearReadModelRequestCache,
  createReadModelEtag,
  getReadModel,
  normalizeReadModelRow,
  publishReadModel
} from '../src/shared/read-models.js';

function storedRow(overrides = {}) {
  return {
    model_key: 'test:v1',
    schema_version: 1,
    payload_json: { value: 7 },
    etag: '"etag"',
    generated_at: '2026-07-18T12:00:00Z',
    source_updated_at: '2026-07-18T11:59:00Z',
    fresh_until: '2026-07-18T12:01:00Z',
    published_at: '2026-07-18T12:00:01Z',
    run_id: 12,
    metadata_json: {},
    ...overrides
  };
}

test('normalizeReadModelRow reports freshness without deleting stale last-good data', () => {
  const fresh = normalizeReadModelRow(storedRow(), {
    nowMs: Date.parse('2026-07-18T12:00:30Z')
  });
  const stale = normalizeReadModelRow(storedRow(), {
    nowMs: Date.parse('2026-07-18T12:02:00Z')
  });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageSeconds, 30);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.payload, { value: 7 });
});

test('getReadModel can explicitly reject a stale row', async () => {
  const client = { query: async () => ({ rows: [storedRow()] }) };
  assert.equal(await getReadModel('test:v1', {
    client,
    allowStale: false,
    nowMs: Date.parse('2026-07-18T12:02:00Z')
  }), null);
  assert.equal((await getReadModel('test:v1', {
    client,
    nowMs: Date.parse('2026-07-18T12:02:00Z')
  })).stale, true);
});

test('public read-model bursts share one raw-row load and recompute age per request', async () => {
  clearReadModelRequestCache();
  let reads = 0;
  const query = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { rows: [storedRow({ model_key: 'burst:v1' })] };
  };
  const models = await Promise.all(Array.from({ length: 50 }, () => getReadModel('burst:v1', {
    query,
    nowMs: Date.parse('2026-07-18T12:00:30Z')
  })));
  const later = await getReadModel('burst:v1', {
    query,
    nowMs: Date.parse('2026-07-18T12:00:45Z')
  });

  assert.equal(reads, 1);
  assert.equal(models.every((model) => model.ageSeconds === 30), true);
  assert.equal(later.ageSeconds, 45);
  clearReadModelRequestCache();
});

test('publishReadModel writes a deterministic ETag and additive metadata', async () => {
  let statement;
  const client = {
    async query(sql, params) {
      statement = { sql, params };
      return {
        rows: [storedRow({
          model_key: params[0],
          schema_version: params[1],
          payload_json: params[2],
          etag: params[3],
          generated_at: params[4],
          source_updated_at: params[5],
          fresh_until: params[6],
          run_id: params[7],
          metadata_json: params[8]
        })]
      };
    }
  };
  const payload = { answer: 42 };
  const model = await publishReadModel('answer:v1', payload, {
    client,
    generatedAt: '2026-07-18T12:00:00Z',
    ttlMs: 30_000,
    metadata: { source: 'test' }
  });
  assert.match(statement.sql, /on conflict \(model_key\)/);
  assert.equal(statement.params[3], createReadModelEtag(payload));
  assert.equal(statement.params[6], '2026-07-18T12:00:30.000Z');
  assert.deepEqual(model.metadata, { source: 'test' });
});

test('failed read-model builds record the error without publishing over last-good', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('insert into api_read_model_runs')) return { rows: [{ id: 99 }] };
      return { rows: [] };
    }
  };
  await assert.rejects(() => buildAndPublishReadModel({
    modelKey: 'test:v1',
    client,
    build: async () => { throw new Error('provider unavailable'); }
  }), /provider unavailable/);
  assert.equal(statements.some((sql) => sql.includes('insert into api_read_models')), false);
  assert.equal(statements.some((sql) => sql.includes('update api_read_model_runs')), true);
});
