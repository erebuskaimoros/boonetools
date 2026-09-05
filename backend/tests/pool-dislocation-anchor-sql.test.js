import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { resolvePoolDislocationBlockAnchorsAcrossRpcRanges } from '../src/shared/pool-dislocation-backfill.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
test('block anchors persist across PostgreSQL connections without nested acquisition locks',
  { skip: !databaseUrl }, async () => {
    assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
    const db = new pg.Client({ connectionString: databaseUrl });
    const next = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    await next.connect();
    const origin = Date.parse('2026-07-22T12:00:00Z');
    const time = (height) => new Date(origin + (height - 100) * 6000).toISOString();
    const target = time(150);
    const anchorNamespace = 'thorchain-mainnet:pool-dislocation-block-anchor:v1';
    const timeNamespace = 'thorchain-mainnet:block-time:v1';
    let calls = 0;
    try {
      await db.query("set statement_timeout = '3s'");
      await db.query('delete from source_observations where namespace = $1 and identity = $2', [anchorNamespace, target]);
      await db.query('delete from source_observations where namespace = $1 and identity = any($2::text[])', [timeNamespace, ['150', '151']]);
      const first = await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([target], {
        client: db, rpcUrls: ['https://rpc.invalid'], requestDelayMs: 0,
        fetchStatus: async () => ({ earliestHeight: 100, earliestBlockTime: time(100),
          latestHeight: 300, latestBlockTime: time(300) }),
        fetchBlock: async (height) => { calls++; return { height, blockTime: time(height) }; }
      });
      assert.equal(calls, 2);
      assert.equal(first[0].height, 150);
      const proof = (await db.query('select payload_json, completed_at from source_observations where namespace = $1 and identity = $2',
        [anchorNamespace, target])).rows[0];
      assert.ok(proof.completed_at);
      assert.equal(proof.payload_json.nextHeight, 151);
      assert.deepEqual(await resolvePoolDislocationBlockAnchorsAcrossRpcRanges([target], {
        client: next, rpcUrls: [],
        fetchStatus: async () => { throw new Error('completed proof must survive provider removal'); }
      }), first);
      assert.equal(calls, 2);
    } finally {
      await db.query('delete from source_observations where namespace = $1 and identity = $2', [anchorNamespace, target]);
      await db.query('delete from source_observations where namespace = $1 and identity = any($2::text[])', [timeNamespace, ['150', '151']]);
      await next.end();
      await db.end();
    }
  });
