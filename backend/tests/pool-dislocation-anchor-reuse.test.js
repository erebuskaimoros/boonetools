import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoolDislocationBlockAnchorsAcrossRpcRanges } from '../src/shared/pool-dislocation-backfill.js';
import { acquisitionDatabase } from './fixtures/acquisition-db.js';

const origin = Date.parse('2026-07-22T12:00:00Z');
const blockTime = (height) => new Date(origin + (height - 100) * 6000).toISOString();

function database() {
  const db = acquisitionDatabase();
  const query = db.query.bind(db);
  db.query = async (sql, params) => sql.includes('from chain_block_headers')
    ? { rows: [] } : query(sql, params);
  return db;
}

function provider(client) {
  const requests = [];
  const state = { head: 300, offline: false };
  return { requests, state, options: {
    client, rpcUrls: ['https://rpc.test'], requestDelayMs: 0,
    fetchStatus: async () => {
      requests.push('status');
      if (state.offline) throw new Error('archive unavailable');
      return { earliestHeight: 100, earliestBlockTime: blockTime(100),
        latestHeight: state.head, latestBlockTime: blockTime(state.head) };
    },
    fetchBlock: async (height) => {
      requests.push(height);
      if (state.offline) throw new Error('archive unavailable');
      return { height, blockTime: blockTime(height) };
    }
  } };
}

test('completed historical anchors survive a later repair run and an advancing RPC head', async () => {
  const rpc = provider(database());
  const buckets = ['2026-07-22T12:05:00Z', '2026-07-22T12:10:03Z'];
  const first = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
  assert.deepEqual(first.map((anchor) => anchor.height), [150, 200]);
  assert.ok(rpc.requests.includes(151), 'anchor must prove that its next block is after the target');
  const before = rpc.requests.length;
  rpc.state.head = 400;
  const second = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
  assert.deepEqual(second, first);
  assert.equal(rpc.requests.length, before, 'completed anchors must not repeat status or block RPC calls');
});

test('completed historical anchors remain usable when the archive subsequently becomes unavailable', async () => {
  const rpc = provider(database());
  const buckets = ['2026-07-22T12:05:00Z'];
  const first = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
  rpc.state.offline = true;
  const second = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
  assert.deepEqual(second, first);
});

test('mixed cached and missing points only resolve the missing bracket', async () => {
  const rpc = provider(database());
  const firstBucket = '2026-07-22T12:05:00Z';
  await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([firstBucket], rpc.options);
  rpc.requests.length = 0;
  const anchors = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([
    '2026-07-22T12:10:03Z', firstBucket
  ], rpc.options);
  assert.deepEqual(anchors.map((anchor) => anchor.height), [200, 150]);
  assert.equal(rpc.requests.filter((request) => request === 'status').length, 1);
  assert.ok(!rpc.requests.includes(150) && !rpc.requests.includes(151));
});

test('shared stored timestamps and chain headers satisfy search candidates without block RPC calls', async () => {
  const db = database();
  const { saveAcquisition } = await import('../src/shared/acquisition-cache.js');
  await saveAcquisition(db, {
    namespace: 'thorchain-mainnet:block-time:v1', identity: '150',
    payload: { height: 150, blockTime: blockTime(150) }, completedAt: new Date().toISOString()
  });
  const query = db.query.bind(db);
  db.query = async (sql, params) => sql.includes('from chain_block_headers') && params[0] === 151
    ? { rows: [{ height: 151, block_time: blockTime(151) }] } : query(sql, params);
  const rpc = provider(db);
  const anchors = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(['2026-07-22T12:05:00Z'], rpc.options);
  assert.equal(anchors[0].height, 150);
  assert.deepEqual(rpc.requests, ['status']);
});

test('later bucket failure retains completed proofs and resumes without repeating their search', async () => {
  const db = database();
  const rpc = provider(db);
  const fetchBlock = rpc.options.fetchBlock;
  let failing = true;
  rpc.options.fetchBlock = async (height) => {
    if (failing && height >= 200) throw new Error('archive unavailable');
    return fetchBlock(height);
  };
  const buckets = ['2026-07-22T12:05:00Z', '2026-07-22T12:10:03Z'];
  const partial = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, {
    ...rpc.options, allowUnresolved: true
  });
  assert.deepEqual(partial.map((anchor) => anchor.height), [150]);
  failing = false;
  rpc.requests.length = 0;
  const resumed = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
  assert.deepEqual(resumed.map((anchor) => anchor.height), [150, 200]);
  assert.ok(!rpc.requests.includes(150) && !rpc.requests.includes(151));
});

test('an exact next-block boundary resolves to that block, and bad height responses never complete', async () => {
  const db = database();
  const rpc = provider(db);
  const anchors = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([blockTime(151)], rpc.options);
  assert.equal(anchors[0].height, 151);
  assert.ok(rpc.requests.includes(152));
  const broken = provider(database());
  broken.options.fetchBlock = async (height) => ({ height: height + 1, blockTime: blockTime(height) });
  await assert.rejects(resolvePoolDislocationBlockAnchorsAcrossRpcRanges([blockTime(150)], broken.options), /requested height/);
  assert.equal([...broken.options.client.rows.values()].filter((row) => row.namespace.includes('block-anchor')).length, 0);
});

test('incomplete, mismatched and non-adjacent saved proofs are never treated as completed anchors', async () => {
  for (const change of [
    (row) => { row.completed_at = null; row.expires_at = '2099-01-01T00:00:00Z'; },
    (row) => { row.payload_json.observedAt = blockTime(151); },
    (row) => { row.payload_json.nextHeight += 1; },
    (row) => { row.payload_json.nextBlockTime = row.payload_json.blockTime; },
    (row) => { row.payload_json.blockTime = blockTime(152); }
  ]) {
    const db = database();
    const rpc = provider(db);
    const buckets = [blockTime(150)];
    await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
    const row = [...db.rows.values()].find((value) => value.namespace.includes('block-anchor'));
    change(row);
    rpc.state.offline = true;
    await assert.rejects(resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options), /archive unavailable/);
    rpc.state.offline = false;
    const repaired = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
    assert.equal(repaired[0].height, 150);
    rpc.state.offline = true;
    assert.deepEqual(await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options), repaired);
  }
});

test('proofs can be reused after provider configuration disappears', async () => {
  const rpc = provider(database());
  const buckets = [blockTime(150)];
  const first = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, rpc.options);
  const before = rpc.requests.length;
  assert.deepEqual(await resolvePoolDislocationBlockAnchorsAcrossRpcRanges(buckets, {
    ...rpc.options, rpcUrls: []
  }), first);
  assert.equal(rpc.requests.length, before);
});

test('cold search stays bounded when a late chain halt makes interpolation crawl', async () => {
  const requests = [];
  const time = (height) => new Date(origin + (height < 1000 ? height * 1000 : 86_400_000)).toISOString();
  const target = new Date(origin + 800_500).toISOString();
  const anchors = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([target], {
    rpcUrls: ['https://rpc.test'], requestDelayMs: 0,
    fetchStatus: async () => ({ earliestHeight: 1, earliestBlockTime: time(1),
      latestHeight: 1000, latestBlockTime: time(1000) }),
    fetchBlock: async (height) => { requests.push(height); return { height, blockTime: time(height) }; }
  });
  assert.equal(anchors[0].height, 800);
  assert.ok(requests.length <= 24, `expected bounded search, saw ${requests.length} block requests`);
});

test('uniform timeline retains the two-probe interpolation fast path', async () => {
  const rpc = provider(undefined);
  await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([blockTime(150)], rpc.options);
  assert.deepEqual(rpc.requests, ['status', 150, 151]);
});

test('bounded search selects the last block in an equal-timestamp plateau', async () => {
  const requests = [];
  const time = (height) => new Date(origin + (height < 1000
    ? Math.min(height, 800) * 1000 : 86_400_000)).toISOString();
  const anchors = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([time(800)], {
    rpcUrls: ['https://rpc.test'], requestDelayMs: 0,
    fetchStatus: async () => ({ earliestHeight: 1, earliestBlockTime: time(1),
      latestHeight: 1000, latestBlockTime: time(1000) }),
    fetchBlock: async (height) => { requests.push(height); return { height, blockTime: time(height) }; }
  });
  assert.equal(anchors[0].height, 999);
  assert.ok(requests.length <= 24, `expected bounded plateau search, saw ${requests.length} block requests`);
});
