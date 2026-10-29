import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ingestPoolAnalysisHistory } from '../src/shared/pool-analysis-ingestion.js';
import { parsePoolAnalysisSwapInterval } from '../src/shared/pool-analysis.js';
import {
  loadPoolAnalysisRollingAggregates,
  loadPoolAnalysisRollingEdges,
  markPoolAnalysisRollingFailure,
  savePoolAnalysisIntradaySnapshot,
  upsertPoolAnalysisDays
} from '../src/shared/pool-analysis-store.js';

// Opt in only with an explicitly named disposable test database; never DATABASE_URL.
const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const migrations = [
  '051_pool_analysis.sql', '059_pool_analysis_depth.sql', '060_pool_analysis_completion.sql',
  '061_shared_acquisition.sql', '066_pool_analysis_intraday_snapshots.sql'
];
const source = 'liquify-midgard-swaps';
const cutoff = Date.parse('2026-10-20T00:30:00Z') / 1000;
const exactAmounts = {
  totalVolume: '9007199254740993', totalVolumeUSD: '9007199254740995',
  totalFees: '9007199254740997', runePriceUSD: '2.123456789123456789'
};
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const midnight = (seconds) => Math.floor(seconds / 86400) * 86400;

function ingestionOptions(asset, at, requests, allowSwaps) {
  const now = iso(at + 60);
  return {
    assets: [asset], now, healthNow: now, rolling: true, historyRequestLimit: 0,
    startDate: iso(at).slice(0, 10),
    coreSnapshot: { payload: {
      field_meta: { pools: { status: 'fresh', fetched_at: now } },
      pools: [{ asset, status: 'available', balance_rune: '100000000',
        balance_asset: '100000000', asset_tor_price: '200000000' }]
    } },
    fetchMidgard: async (route) => {
      requests.push(route);
      if (route === '/health') return { database: true, inSync: true,
        lastAggregated: { height: 28000000, timestamp: at + 20 } };
      assert.equal(allowSwaps, true, 'a persisted prefix must not trigger a history refetch');
      const url = new URL(route, 'https://fixture.invalid');
      assert.equal(url.pathname, '/history/swaps');
      assert.equal(url.searchParams.get('pool'), asset);
      assert.equal(url.searchParams.get('from'), String(midnight(at)));
      assert.equal(url.searchParams.get('to'), String(at));
      return { meta: { startTime: midnight(at), endTime: at, ...exactAmounts } };
    }
  };
}

async function dailyRow(client, asset, day) {
  return (await client.query('select * from pool_analysis_daily where asset = $1 and day = $2', [asset, day])).rows[0];
}

async function syncState(client, asset) {
  return (await client.query('select * from pool_analysis_sync_state where asset = $1', [asset])).rows[0];
}

function assertSuccessful(result, expectedPages) {
  assert.equal(result.failed_pools, 0);
  assert.equal(result.successful_pools, 1);
  assert.equal(result.failed_depth_pools, 0);
  assert.equal(result.swap_pages, expectedPages);
  assert.equal(result.historical_requests, 0);
}

test('PostgreSQL preserves Pool Analysis provenance through cached and midnight ingestion',
  { skip: !databaseUrl }, async (t) => {
    assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
    const schema = `pool_snapshot_test_${randomBytes(8).toString('hex')}`;
    const quotedSchema = `"${schema}"`;
    const admin = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    let connected = false, schemaCreated = false;
    const withClient = async (run) => {
      const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        await client.query(`set search_path to ${quotedSchema}`);
        return await run(client);
      } finally { await client.end(); }
    };
    try {
      await admin.connect();
      connected = true;
      await admin.query(`create schema ${quotedSchema}`);
      schemaCreated = true;
      await admin.query(`set search_path to ${quotedSchema}`);
      for (const filename of migrations) {
        // Production migrations qualify public tables. Redirect only this in-memory
        // copy to the random schema; no public objects or migration files change.
        const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
        await admin.query(sql.replaceAll('public.', `${quotedSchema}.`));
      }

      await t.test('same-cutoff ingestion after reconnect reuses exact amounts and clears stale/error state', async () => {
        const asset = 'BTC.BTC';
        let freshRow;
        await withClient(async (client) => {
          const completed = parsePoolAnalysisSwapInterval({
            startTime: midnight(cutoff) - 86400, endTime: midnight(cutoff),
            totalVolume: '9007199254740993000', totalVolumeUSD: '12345678901234567890',
            totalFees: '9007199254740997000', runePriceUSD: '2'
          }, { asset });
          await upsertPoolAnalysisDays(client, [{ ...completed, completed_at: iso(cutoff) }]);
          await savePoolAnalysisIntradaySnapshot(client, {
            asset, interval_end: iso(cutoff - 86400), volume_rune_e8: '12345',
            volume_usd_e2: '100', fees_rune_e8: '3', rune_price_usd: '2'
          });
          const requests = [];
          assertSuccessful(await ingestPoolAnalysisHistory(client, ingestionOptions(asset, cutoff, requests, true)), 1);
          assert.equal(requests.filter((route) => route.startsWith('/history/swaps?')).length, 1);
          freshRow = await dailyRow(client, asset, '2026-10-20');
          assert.equal(freshRow.source, source);
          assert.equal(freshRow.volume_rune_e8, exactAmounts.totalVolume);
          assert.equal(freshRow.volume_usd_e2, exactAmounts.totalVolumeUSD);
          assert.equal(freshRow.fees_rune_e8, exactAmounts.totalFees);
          assert.equal(freshRow.rune_price_usd, exactAmounts.runePriceUSD);
          assert.equal(freshRow.partial, true);
          assert.equal(freshRow.completed_at, null);

          await markPoolAnalysisRollingFailure(client, asset, 'Prior failed refresh');
          await client.query('update pool_analysis_sync_state set last_error = $2 where asset = $1', [asset, 'Prior failed refresh']);
          const rolling = (await loadPoolAnalysisRollingAggregates(client, iso(cutoff + 60)))
            .find((row) => row.asset === asset && row.period_id === '24h');
          assert.equal(rolling.window_mode, 'rolling');
          assert.equal(rolling.stale, true);
        });

        // A new connection ensures this path uses durable SQL cache state, not a
        // response held by the first collector/client.
        await withClient(async (client) => {
          const cached = await loadPoolAnalysisRollingEdges(client, asset, cutoff);
          assert.equal(cached.head.source, source);
          assert.equal(cached.head.volume_rune_e8, exactAmounts.totalVolume);
          const requests = [];
          assertSuccessful(await ingestPoolAnalysisHistory(client, ingestionOptions(asset, cutoff, requests, false)), 0);
          assert.deepEqual(requests, ['/health']);
          const reused = await dailyRow(client, asset, '2026-10-20');
          for (const key of ['source', 'volume_rune_e8', 'volume_usd_e2', 'fees_rune_e8', 'rune_price_usd',
            'interval_start', 'interval_end', 'partial', 'completed_at']) assert.deepEqual(reused[key], freshRow[key], key);
          const state = await syncState(client, asset);
          assert.equal(state.last_error, '');
          assert.equal(state.stats_json.swap_pages, 0);
          assert.equal(state.stats_json.completed_swap_days, 0);
          assert.equal(state.last_completed_day, null);
          const rolling = (await loadPoolAnalysisRollingAggregates(client, iso(cutoff + 60)))
            .find((row) => row.asset === asset && row.period_id === '24h');
          assert.equal(rolling.stale, false);
          assert.equal(rolling.refresh_error, '');
          assert.equal(rolling.volume_rune_e8, (9007199254740993000n + BigInt(exactAmounts.totalVolume) - 12345n).toString());
          assert.equal((await client.query(`select count(*)::integer as count from pool_analysis_intraday_snapshots
            where asset = $1 and bucket_end = $2`, [asset, iso(cutoff)])).rows[0].count, 1);
        });
      });

      await t.test('midnight initial and cached collection persist a zero prefix without fetching history or claiming completion', async () => {
        const asset = 'ETH.ETH';
        const at = midnight(cutoff);
        for (let attempt = 0; attempt < 2; attempt++) await withClient(async (client) => {
          const requests = [];
          assertSuccessful(await ingestPoolAnalysisHistory(client, ingestionOptions(asset, at, requests, false)), 0);
          assert.deepEqual(requests, ['/health']);
          const row = await dailyRow(client, asset, '2026-10-20');
          assert.equal(row.source, source);
          assert.equal(row.volume_rune_e8, '0');
          assert.equal(row.volume_usd_e2, '0');
          assert.equal(row.fees_rune_e8, '0');
          assert.equal(row.interval_start.toISOString(), iso(at));
          assert.equal(row.interval_end.toISOString(), iso(at));
          assert.equal(row.partial, true);
          assert.equal(row.completed_at, null);
          const state = await syncState(client, asset);
          assert.equal(state.last_error, '');
          assert.equal(state.last_completed_day, null);
          assert.equal(state.stats_json.completed_swap_days, 0);
          const cached = await loadPoolAnalysisRollingEdges(client, asset, at);
          assert.equal(cached.head.source, source);
          assert.equal(cached.head.partial, true);
          assert.equal(cached.head.volume_rune_e8, '0');
        });
      });

      await t.test('missing 24H recovery survives reconnect without refetching or rewriting completed history', async () => {
        const asset = 'ZEC.ZEC';
        const at = Date.parse('2026-10-28T23:45:00Z') / 1000;
        const boundary = at - 86400;
        const current = { totalVolume: '50000000000', totalVolumeUSD: '30000', totalFees: '200000000', runePriceUSD: '0.6' };
        const prefix = { totalVolume: '70000000000', totalVolumeUSD: '42000', totalFees: '700000000', runePriceUSD: '0.6' };
        let original;
        await withClient(async (client) => {
          await upsertPoolAnalysisDays(client, [{ ...parsePoolAnalysisSwapInterval({
            startTime: midnight(boundary), endTime: midnight(at),
            totalVolume: '100000000000', totalVolumeUSD: '60000', totalFees: '1000000000', runePriceUSD: '0.6'
          }, { asset }), completed_at: iso(midnight(at) + 60) }]);
          original = await dailyRow(client, asset, '2026-10-27');
        });
        for (let attempt = 0; attempt < 2; attempt++) await withClient(async (client) => {
          const requests = [];
          const options = {
            ...ingestionOptions(asset, at, requests, true),
            loadPendingDays: async () => [],
            fetchMidgard: async (route) => {
              requests.push(route);
              if (route === '/health') return { database: true, inSync: true,
                lastAggregated: { height: 28000000, timestamp: at + 20 } };
              assert.equal(attempt, 0, 'reconnected collection must reuse both durable prefixes');
              const query = new URL(route, 'https://fixture.invalid').searchParams;
              const end = Number(query.get('to'));
              assert.equal(query.get('pool'), asset);
              assert.ok([at, boundary].includes(end));
              assert.equal(query.get('from'), String(midnight(end)));
              assert.equal(query.has('interval'), false);
              return { meta: { startTime: query.get('from'), endTime: end, ...(end === at ? current : prefix) } };
            }
          };
          assertSuccessful(await ingestPoolAnalysisHistory(client, options), attempt === 0 ? 2 : 0);
          assert.equal(requests.length, attempt === 0 ? 3 : 1);
          const repaired = await loadPoolAnalysisRollingEdges(client, asset, boundary);
          assert.equal(repaired.head.fees_rune_e8, prefix.totalFees);
          assert.deepEqual(await dailyRow(client, asset, '2026-10-27'), original);
          const metric = (await loadPoolAnalysisRollingAggregates(client, iso(at + 60)))
            .find((row) => row.asset === asset && row.period_id === '24h');
          assert.equal(metric.window_mode, 'rolling');
          assert.equal(metric.window_start, iso(boundary));
          assert.equal(metric.window_end, iso(at));
          assert.equal(metric.fees_rune_e8, '500000000');
          assert.equal(metric.fees_usd, 3);
          assert.equal(metric.volume_usd, 480);
          assert.equal(metric.stale, false);
        });
      });

      await t.test('a cached provisional reinsert cannot overwrite a completed historical daily row', async () => {
        await withClient(async (client) => {
          const asset = 'DOGE.DOGE';
          const at = cutoff - 86400;
          const completed = {
            ...parsePoolAnalysisSwapInterval({ startTime: midnight(at), endTime: midnight(at) + 86400,
              ...exactAmounts }, { asset }), completed_at: iso(cutoff)
          };
          await upsertPoolAnalysisDays(client, [completed]);
          const original = await dailyRow(client, asset, '2026-10-19');
          await savePoolAnalysisIntradaySnapshot(client, { asset, interval_end: iso(at),
            volume_rune_e8: '1', volume_usd_e2: '2', fees_rune_e8: '3', rune_price_usd: '4' });
          const cached = await loadPoolAnalysisRollingEdges(client, asset, at);
          assert.equal(cached.head.source, source);
          for (const force of [false, true]) {
            assert.equal(await upsertPoolAnalysisDays(client, [{ ...cached.head, completed_at: null }], { force }), 0);
            assert.deepEqual(await dailyRow(client, asset, '2026-10-19'), original);
          }
        });
      });
    } finally {
      try {
        if (connected) await admin.query('rollback');
        if (schemaCreated) await admin.query(`drop schema ${quotedSchema} cascade`);
      } finally { await admin.end(); }
    }
  });
