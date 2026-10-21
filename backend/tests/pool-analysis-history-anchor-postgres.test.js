import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadPoolAnalysisSyncStates } from '../src/shared/pool-analysis-store.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;

test('PostgreSQL coverage anchors retain the earliest durable tracking or observation date', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `pool_coverage_test_${randomBytes(8).toString('hex')}`;
  const quotedSchema = `"${schema}"`;
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  let created = false;
  try {
    await client.connect();
    await client.query(`create schema ${quotedSchema}`);
    created = true;
    await client.query(`set search_path to ${quotedSchema}`);
    for (const name of ['051_pool_analysis.sql', '059_pool_analysis_depth.sql', '060_pool_analysis_completion.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await client.query(sql.replaceAll('public.', `${quotedSchema}.`));
    }
    await client.query(`insert into pool_analysis_sync_state (asset, first_day) values
      ('ZEC.ZEC', '2026-10-02'), ('GAP.GAP', '2026-10-02'),
      ('OLD.OLD', '2021-04-01'), ('UNKNOWN.UNKNOWN', null)`);
    await client.query(`insert into pool_analysis_refresh_state (asset, lane, first_tracked_day) values
      ('ZEC.ZEC', 'swaps', '2026-10-02'), ('ZEC.ZEC', 'depth', '2026-10-02'),
      ('GAP.GAP', 'swaps', '2026-10-02'), ('GAP.GAP', 'depth', '2026-09-30'),
      ('OLD.OLD', 'swaps', '2026-10-02')`);
    const rows = await loadPoolAnalysisSyncStates(client);
    assert.equal(rows.length, 4, 'two lane anchors must not duplicate pool rows');
    const byAsset = new Map(rows.map((row) => [row.asset, row]));
    const day = (value) => value?.toISOString().slice(0, 10) ?? null;
    assert.equal(day(byAsset.get('ZEC.ZEC').history_start_day), '2026-10-02');
    assert.equal(day(byAsset.get('GAP.GAP').history_start_day), '2026-09-30');
    assert.equal(day(byAsset.get('GAP.GAP').first_day), '2026-10-02', 'raw observation boundary is unchanged');
    assert.equal(day(byAsset.get('OLD.OLD').history_start_day), '2021-04-01');
    assert.equal(byAsset.get('UNKNOWN.UNKNOWN').history_start_day, null);
  } finally {
    if (created) {
      await client.query('rollback');
      await client.query(`drop schema ${quotedSchema} cascade`);
    }
    await client.end();
  }
});
