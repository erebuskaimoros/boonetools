import test from 'node:test';
import assert from 'node:assert/strict';

const nowMs = Date.parse('2026-09-02T12:00:00Z');

test('fresh durable head avoids RPC while stale and future observations use fallback', async () => {
  const { resolveThorchainHead } = await import('../src/shared/chain-data.js');
  let calls = 0;
  const fetchHead = async () => { calls += 1; return { height: 103, blockTime: new Date(nowMs).toISOString() }; };
  const client = { query: async () => ({ rows: [] }) };
  const result = await resolveThorchainHead(client, { nowMs, fetchHead,
    loadHead: async () => ({ height: 102, time: new Date(nowMs - 6000).toISOString() }) });
  assert.equal(result.height, 102);
  assert.equal(calls, 0);
  for (const offset of [-60000, 6000]) {
    assert.equal((await resolveThorchainHead(client, { nowMs, fetchHead,
      loadHead: async () => ({ height: 102, time: new Date(nowMs + offset).toISOString() }) })).height, 103);
  }
  assert.equal(calls, 2);
});

test('fresh core head remains valid during a chain halt without relabeling old block time', async () => {
  const { resolveThorchainHead } = await import('../src/shared/chain-data.js');
  const result = await resolveThorchainHead({}, { nowMs, loadHead: async () => null,
    loadCore: async () => ({ payload: { lastblock: [{ chain: 'THOR', thorchain: '100' }],
      field_meta: { lastblock: { status: 'fresh', fetched_at: new Date(nowMs - 1000).toISOString() } } } }),
    fetchHead: async () => { throw new Error('unnecessary head fetch'); } });
  assert.equal(result.height, 100);
  assert.equal(result.blockTime, null);
  assert.equal(result.observedAt, new Date(nowMs - 1000).toISOString());
});

test('an exact stored block timestamp is reused without calling the archive', async () => {
  const { resolveThorchainBlockTime } = await import('../src/shared/chain-data.js');
  const client = { query: async (sql) => ({ rows: sql.includes('from chain_block_headers')
    ? [{ height: '99', block_time: '2026-09-01T12:00:00Z' }] : [] }) };
  const result = await resolveThorchainBlockTime(client, 99, { nowMs,
    fetchBlock: async () => { throw new Error('unnecessary archive fetch'); } });
  assert.equal(result, '2026-09-01T12:00:00.000Z');
});

test('completed exact timestamp reuse does not write the same immutable observation again', async () => {
  const { resolveThorchainBlockTime } = await import('../src/shared/chain-data.js');
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes('from source_observations')) return { rows: [{
      payload_json: { height: 99, blockTime: '2026-09-01T12:00:00.000Z' },
      observed_at: '2026-09-01T12:00:00Z', completed_at: '2026-09-01T12:00:00Z'
    }] };
    return { rows: [{ height: '99', block_time: '2026-09-01T12:00:00Z' }] };
  } };
  assert.equal(await resolveThorchainBlockTime(client, 99, { nowMs }), '2026-09-01T12:00:00.000Z');
  assert.equal(queries.some((sql) => sql.includes('insert into source_observations')), false);
  assert.equal(queries.length, 1);
});
