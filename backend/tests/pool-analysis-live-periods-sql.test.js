import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  loadPoolAnalysisCompletedDays, loadPoolAnalysisRollingAggregates, loadPoolAnalysisRollingEdges,
  savePoolAnalysisRollingSnapshot, markPoolAnalysisRollingFailure,
  savePoolAnalysisIntradaySnapshot, loadPoolAnalysisBoundarySnapshots
} from '../src/shared/pool-analysis-store.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
test('quarterhour prefixes survive restart without duplicate buckets, retain exact integers, and select exact boundaries', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const asset = `ROLLINGTEST.BTC${process.pid}`;
  const observed = '2026-09-05T12:15:00.000Z';
  const cutoff = Date.parse(observed) / 1000;
  const head = { asset, interval_end: observed, volume_rune_e8: '9007199254740993', volume_usd_e2: '100', fees_rune_e8: '3', rune_price_usd: '2' };
  try {
    await savePoolAnalysisIntradaySnapshot(client, head);
    await savePoolAnalysisIntradaySnapshot(client, { ...head, volume_rune_e8: '999' });
    const reconnected = new pg.Client({ connectionString: databaseUrl });
    await reconnected.connect();
    try { assert.equal((await loadPoolAnalysisRollingEdges(reconnected, asset, cutoff)).head.volume_rune_e8, '9007199254740993'); }
    finally { await reconnected.end(); }
    assert.equal((await client.query('select count(*)::integer as count from pool_analysis_intraday_snapshots where asset = $1', [asset])).rows[0].count, 1);
    assert.equal(await loadPoolAnalysisRollingEdges(client, asset, cutoff + 900), null);
    assert.equal((await loadPoolAnalysisBoundarySnapshots(client, asset, cutoff + 86400, [{ days: 1 }])).length, 1);
    assert.equal((await loadPoolAnalysisBoundarySnapshots(client, asset, cutoff + 86400 + 900, [{ days: 1 }])).length, 0);
    const periods = [{ asset, period_id: '24h', window_mode: 'rolling', window_end: observed, volume_rune_e8: '9007199254740993' },
      { asset, period_id: '7d', window_mode: 'completed-days', window_end: '2026-09-05T00:00:00.000Z' }];
    await savePoolAnalysisRollingSnapshot(client, asset, periods, observed);
    await markPoolAnalysisRollingFailure(client, asset, 'Provider unavailable');
    let loaded = (await loadPoolAnalysisRollingAggregates(client, '2026-09-05T12:16:00Z')).filter((row) => row.asset === asset);
    assert.equal(loaded[0].stale, true);
    assert.equal(loaded[0].window_end, observed);
    assert.equal(loaded[1].stale, false);
    await savePoolAnalysisRollingSnapshot(client, asset, [], '2026-09-05T11:00:00Z');
    loaded = (await loadPoolAnalysisRollingAggregates(client, '2026-09-05T12:16:00Z')).filter((row) => row.asset === asset);
    assert.equal(loaded.length, 2, 'older publication cannot replace a newer source snapshot');
    await client.query('begin');
    await client.query(`insert into pool_analysis_daily (asset, day, volume_rune_e8, volume_usd_e2, fees_rune_e8, rune_price_usd, completed_at)
      values ($1, '2026-09-04', 9007199254740993, 1, 1, 1, $2)`, [asset, observed]);
    assert.equal((await loadPoolAnalysisCompletedDays(client, asset, cutoff))[0].volume_rune_e8, '9007199254740993');
    await client.query('rollback');
  } finally {
    await client.query('rollback');
    await client.query("delete from source_observations where namespace = 'thorchain-mainnet:pool-analysis-rolling:v1' and identity = $1", [asset]);
    await client.query('delete from pool_analysis_intraday_snapshots where asset = $1', [asset]);
    await client.end();
  }
});
