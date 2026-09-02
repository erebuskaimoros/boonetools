import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  POOL_ANALYSIS_TABLE_PERIODS,
  buildPoolAnalysisReadModel,
  buildPoolAnalysisRows,
  buildPoolAnalysisSeries,
  parsePoolAnalysisDepthInterval,
  parsePoolAnalysisSwapInterval
} from '../src/shared/pool-analysis.js';
import { loadPoolAnalysisAggregates, loadPoolAnalysisSeries, upsertPoolAnalysisDepthDays } from '../src/shared/pool-analysis-store.js';
import {
  fetchPoolAnalysisSwapHistory,
  fetchPoolAnalysisDepthHistory,
  ingestPoolAnalysisHistory
} from '../src/shared/pool-analysis-ingestion.js';
import { runPoolAnalysisBackfill, runPoolAnalysisScheduler } from '../src/jobs/pool-analysis.js';
import { handlePoolAnalysis, handlePoolAnalysisSeries } from '../src/handlers/pool-analysis.js';

test('Pool Analysis parses exact pool-generated liquidity fees without distribution fields', () => {
  const swap = parsePoolAnalysisSwapInterval({
    startTime: '1727308800',
    endTime: '1727395200',
    totalVolume: '9007199254740993',
    totalVolumeUSD: '1234567',
    totalFees: '7654321',
    runePriceUSD: '4.125'
  }, { asset: 'btc.btc' });
  assert.equal(swap.asset, 'BTC.BTC');
  assert.equal(swap.volume_rune_e8, '9007199254740993');
  assert.equal(swap.fees_rune_e8, '7654321');
  assert.equal(Object.hasOwn(swap, 'pool_earnings_rune_e8'), false);
  assert.equal(swap.source, 'liquify-midgard-swaps');
});

test('Pool Analysis builds every selectable table period from exact daily aggregates', () => {
  const rows = buildPoolAnalysisRows({
    pools: [{
      asset: 'BTC.BTC', status: 'Available', asset_tor_price: '8000000000000',
      balance_asset: '100000000', balance_rune: '100000000000', volume_rune: '10000000000'
    }],
    oraclePayload: { prices: [{ symbol: 'BTC', price: '79000' }, { symbol: 'RUNE', price: '0.5' }] },
    aggregates: [{
      asset: 'BTC.BTC', period_id: '24h', period_days: 1,
      observed_days: 1, volume_rune_e8: '1000000000',
      volume_usd: '500', fees_rune_e8: '10000000', fees_usd: '5',
      first_day: '2026-01-30', last_day: '2026-01-30'
    }, {
      asset: 'BTC.BTC', period_id: '7d', period_days: 7,
      observed_days: 5, volume_rune_e8: '5000000000',
      volume_usd: '25000', fees_rune_e8: '50000000', fees_usd: '250',
      first_day: '2026-01-24', last_day: '2026-01-30'
    }, {
      asset: 'BTC.BTC', period_id: '30d', period_days: 30,
      observed_days: 30, volume_rune_e8: '300000000000',
      volume_usd: '1500000', fees_rune_e8: '3000000000', fees_usd: '15000',
      first_day: '2026-01-01', last_day: '2026-01-30'
    }]
  });
  assert.equal(rows[0].price_usd, 80000);
  assert.equal(rows[0].depth_usd, 500);
  assert.equal(rows[0].total_depth_usd, 1000);
  assert.equal(rows[0].volume_24h_usd, 50);
  assert.equal(rows[0].fee_volume_percent, 1);
  assert.equal(rows[0].annualized_fees_usd, 182500);
  assert.equal(rows[0].annualized_fee_rate_percent, 18.25);
  assert.equal(Object.hasOwn(rows[0], 'annualized_pool_earnings_usd'), false);
  assert.equal(rows[0].period_metrics['24h'].volume_usd, 500);
  assert.equal(rows[0].period_metrics['24h'].fees_usd, 5);
  assert.equal(rows[0].period_metrics['24h'].fee_depth_percent, 0.005);
  assert.equal(rows[0].period_metrics['24h'].volume_depth_percent, 0.5);
  assert.equal(rows[0].period_metrics['24h'].annualized_fees_usd, 1825);
  assert.equal(rows[0].period_metrics['24h'].coverage.expected_days, 1);
  assert.equal(rows[0].period_metrics['7d'].volume_depth_percent, 0.5);
  assert.equal(rows[0].period_metrics['7d'].fee_depth_percent, 0.025);
  assert.equal(rows[0].period_metrics['7d'].coverage.missing_days, 2);
  assert.equal(rows[0].period_metrics['30d'].volume_depth_percent, 5);
  assert.equal(rows[0].period_metrics['30d'].fee_depth_percent, 1.5);
  assert.equal(rows[0].period_metrics['90d'].volume_usd, null);
  assert.equal(rows[0].period_metrics['90d'].coverage.expected_days, 90);
});

test('Pool Analysis falls back to the THORNode network RUNE price when oracle prices are unavailable', async () => {
  const result = await buildPoolAnalysisReadModel({ id: 'db' }, {
    now: new Date('2026-09-01T06:22:17Z'),
    getCoreSnapshot: async () => ({
      stale: false,
      sourceUpdatedAt: '2026-09-01T06:22:00Z',
      payload: {
        pools: [{
          asset: 'BTC.BTC',
          status: 'Available',
          asset_tor_price: '8000000000000',
          balance_asset: '100000000',
          balance_rune: '100000000000'
        }],
        oracle_prices: { prices: [] },
        network: { rune_price_in_tor: '50000000' },
        field_meta: {
          pools: { status: 'fresh' },
          oracle_prices: { status: 'fresh' },
          network: { status: 'fresh' }
        }
      }
    }),
    loadAggregates: async () => [],
    loadSyncStates: async () => []
  });

  assert.equal(result.payload.rune_price_usd, 0.5);
  assert.equal(result.payload.pools[0].depth_usd, 500);
  assert.equal(result.payload.pools[0].total_depth_usd, 1000);
  assert.match(result.payload.sources.current, /network/);
  assert.match(result.payload.warnings.join(' '), /network RUNE price fallback/i);
});

test('Pool Analysis aggregate query requests all table windows in one database round trip', async () => {
  let captured;
  const client = {
    query: async (text, params) => {
      captured = { text, params };
      return { rows: [] };
    }
  };
  await loadPoolAnalysisAggregates(client, '2026-01-30', POOL_ANALYSIS_TABLE_PERIODS);
  assert.match(captured.text, /unnest\(\$2::text\[\], \$3::integer\[\]\)/);
  assert.doesNotMatch(captured.text, /pool_earnings/);
  assert.deepEqual(captured.params, [
    '2026-01-30',
    ['24h', '7d', '30d', '90d', '1y'],
    [1, 7, 30, 90, 365]
  ]);
});

test('30-day Pool Analysis series retains the all-time cumulative fee anchor', () => {
  const rows = Array.from({ length: 31 }, (_, index) => ({
    day: `2026-01-${String(index + 1).padStart(2, '0')}`,
    volume_rune_e8: '100000000',
    volume_usd_e2: '200',
    fees_rune_e8: '100000000',
    rune_price_usd: '2',
    partial: index === 30,
    source: 'midgard'
  }));
  const series = buildPoolAnalysisSeries(rows, { range: '30d', asOf: '2026-01-31T12:00:00Z' });
  assert.equal(series.points.length, 30);
  assert.equal(series.points[0].day, '2026-01-02');
  assert.equal(series.points[0].cumulative_fees_rune_e8, '200000000');
  assert.equal(series.points.at(-1).cumulative_fees_rune_e8, '3100000000');
  assert.equal(series.points.at(-1).partial, true);
});

test('Pool Analysis series serializes PostgreSQL date objects as UTC day labels', () => {
  const series = buildPoolAnalysisSeries([{
    day: new Date('2021-04-10T00:00:00.000Z'),
    volume_rune_e8: '1', volume_usd_e2: '2', fees_rune_e8: '3',
    rune_price_usd: '4', partial: false, source: 'midgard'
  }], { range: 'all', asOf: '2026-08-25T12:00:00Z' });
  assert.equal(series.points[0].day, '2021-04-10');
  assert.equal(series.coverage.first_indexed_day, '2021-04-10');
});

test('Pool Analysis paginates Midgard daily swaps with an exact pool filter', async () => {
  const calls = [];
  const result = await fetchPoolAnalysisSwapHistory('BTC.BTC', {
    startDate: '2024-09-26',
    endDate: '2024-09-27',
    count: 100,
    skipDelay: true,
    fetchMidgard: async (path) => {
      calls.push(path);
      return {
        intervals: [{
          startTime: '1727308800', endTime: '1727395200',
          totalVolume: '10', totalVolumeUSD: '20', totalFees: '1', runePriceUSD: '2'
        }]
      };
    }
  });
  assert.equal(result.rows.length, 1);
  assert.match(calls[0], /pool=BTC\.BTC/);
  assert.match(calls[0], /interval=day/);
});

test('Pool Analysis pagination crosses sparse and halted history instead of treating a short page as EOF', async () => {
  const calls = [];
  const pages = [
    [{
      startTime: '1618012800', endTime: '1618099200',
      totalVolume: '10', totalVolumeUSD: '20', totalFees: '1', runePriceUSD: '2'
    }],
    [{
      startTime: '1633046400', endTime: '1633132800',
      totalVolume: '30', totalVolumeUSD: '40', totalFees: '2', runePriceUSD: '3'
    }],
    []
  ];
  const result = await fetchPoolAnalysisSwapHistory('BTC.BTC', {
    startDate: '2021-04-01',
    endDate: '2021-10-05',
    count: 100,
    maxPages: 5,
    skipDelay: true,
    fetchMidgard: async (path) => {
      calls.push(path);
      return { intervals: pages[calls.length - 1] };
    }
  });
  assert.equal(result.rows.length, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /from=1625875200/);
  assert.match(calls[1], /to=1633478400/);
});

test('Pool Analysis ingestion tolerates one failed pool and persists successful history', async () => {
  let persisted = [];
  const depths = [];
  const states = [];
  const result = await ingestPoolAnalysisHistory({ id: 'db' }, {
    now: new Date('2026-01-31T12:00:00Z'),
    assets: ['BTC.BTC', 'ETH.ETH'],
    coreSnapshot: { payload: { pools: ['BTC.BTC', 'ETH.ETH'].map((asset) => ({
      asset, balance_rune: '1', balance_asset: '1', asset_tor_price: '100000000'
    })), field_meta: { pools: { status: 'fresh', fetched_at: '2026-01-31T12:00:00Z' } } } },
    loadPendingDays: async () => [],
    skipDelay: true,
    fetchSwapHistory: async (asset) => {
      if (asset === 'ETH.ETH') throw new Error('temporary failure');
      return { pages: 1, rows: [{
        asset, day: '2026-01-31', volume_rune_e8: '10', volume_usd_e2: '20',
        fees_rune_e8: '1', partial: true, source: 'swaps'
      }] };
    },
    upsert: async (_client, rows) => { persisted.push(...rows); return rows.length; },
    fetchDepthHistory: async (asset) => ({ pages: 1, rows: [{ asset, day: '2026-01-31', asset_depth_e8: '100' }] }),
    upsertDepths: async (_client, rows) => { depths.push(...rows); return rows.length; },
    updateSyncState: async (_client, state) => { states.push(state); }
  });
  assert.equal(result.successful_pools, 1);
  assert.equal(result.failed_pools, 1);
  assert.equal(persisted.length, 1);
  assert.equal(depths.length, 2);
  assert.equal(result.failed_depth_pools, 0);
  assert.equal(Object.hasOwn(result, 'earnings_pages'), false);
  assert.match(states.find((state) => state.asset === 'ETH.ETH').lastError, /temporary/);
});

test('Pool Analysis depth uses closing two-sided USD value and preserves independent gaps', () => {
  const depth = parsePoolAnalysisDepthInterval({
    startTime: '1727308800', endTime: '1727395200',
    assetDepth: '200000000', runeDepth: '10000000000', assetPriceUSD: '25'
  }, { asset: 'btc.btc', partial: true });
  assert.equal(depth.asset, 'BTC.BTC');
  assert.equal(depth.day, '2024-09-26');
  assert.equal(depth.rune_depth_e8, '10000000000');
  assert.equal(depth.partial, true);
  const series = buildPoolAnalysisSeries([
    { ...depth, depth_partial: depth.partial, depth_source: depth.source, source: 'missing' },
    { day: '2024-09-28', fees_rune_e8: '100000000', rune_price_usd: '5' },
    { day: '2024-09-29', asset_depth_e8: '0', rune_depth_e8: '0' },
    { day: '2024-09-30', asset_depth_e8: '100000000', asset_price_usd: '0' }
  ], { range: 'all', asOf: '2024-09-30' });
  assert.equal(series.points[0].depth_usd, 100);
  assert.equal(series.points[0].depth_partial, true);
  assert.equal(series.points[0].cumulative_fees_usd, null);
  assert.equal(series.points[1].depth_usd, null);
  assert.equal(series.points[2].depth_usd, null);
  assert.equal(series.points[2].cumulative_fees_usd, 5);
  assert.equal(series.points[3].depth_usd, 0);
  assert.equal(series.points[4].depth_usd, null);
  assert.deepEqual(series.coverage.depth_missing_days, ['2024-09-27', '2024-09-28', '2024-09-30']);
});

test('Pool Analysis depth pagination uses the exact pool and advances across sparse history', async () => {
  const calls = [];
  const result = await fetchPoolAnalysisDepthHistory('ETH.LINK-0x123', {
    startDate: '2024-09-26', endDate: '2024-09-28', skipDelay: true,
    fetchMidgard: async (path) => {
      calls.push(path);
      return { intervals: calls.length === 1 ? [{
        startTime: '1727308800', endTime: '1727395200',
        assetDepth: '100000000', runeDepth: '100000000', assetPriceUSD: '2'
      }] : [] };
    }
  });
  assert.match(calls[0], /^\/history\/depths\/ETH.LINK-0X123\?/);
  assert.match(calls[0], /to=1727568000/);
  assert.equal(calls.length, 1);
  assert.equal(result.rows.length, 1);
});

test('Pool Analysis depth failures do not prevent successful fee history from being saved', async () => {
  let saved = 0;
  let state;
  const result = await ingestPoolAnalysisHistory({}, {
    now: new Date('2026-01-31T12:00:00Z'), assets: ['BTC.BTC'],
    coreSnapshot: null,
    loadPendingDays: async () => [{ asset: 'BTC.BTC', lane: 'depth', day: '2026-01-30' }],
    fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 1, timestamp: 1769817600 } }),
    fetchSwapHistory: async () => ({ pages: 1, rows: [{ asset: 'BTC.BTC', day: '2026-01-31' }] }),
    fetchDepthHistory: async () => { throw new Error('depth provider unavailable'); },
    upsert: async (_client, rows) => { saved += rows.length; return rows.length; },
    upsertDepths: async () => { assert.fail('Must not write a failed depth observation'); },
    updateSyncState: async (_client, next) => { state = next; }
  });
  assert.equal(saved, 1);
  assert.equal(result.failed_depth_pools, 1);
  assert.match(state.lastError, /Depth: depth provider unavailable/);
});

test('Pool Analysis stores depth independently and joins it without dropping depth-only days', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
  await upsertPoolAnalysisDepthDays(client, [{ asset: 'BTC.BTC', day: '2026-01-31' }]);
  await loadPoolAnalysisSeries(client, 'BTC.BTC');
  assert.match(calls[0].sql, /insert into pool_analysis_depth_daily/);
  assert.doesNotMatch(calls[0].sql, /fees_rune_e8|volume_rune_e8/);
  assert.match(calls[1].sql, /full outer join/);
  assert.deepEqual(calls[1].params, ['BTC.BTC']);
});

test('scheduled and backfill jobs share the Pool Analysis lock and publication contract', async () => {
  const calls = [];
  const options = {
    lockRunner: async (key, callback) => {
      calls.push(['lock', key]);
      return callback({ id: 'db' });
    },
    ingest: async (_client, input) => {
      calls.push(['ingest', Boolean(input.full)]);
      return {};
    },
    publish: async (input) => {
      calls.push(['publish', input.modelKey]);
      return { ok: true };
    }
  };
  await runPoolAnalysisScheduler(options);
  await runPoolAnalysisBackfill(options);
  assert.deepEqual(calls, [
    ['lock', 'boonetools:pool-analysis'],
    ['ingest', false],
    ['publish', 'pool-analysis:v2'],
    ['lock', 'boonetools:pool-analysis'],
    ['ingest', true],
    ['publish', 'pool-analysis:v2']
  ]);
});

test('Pool Analysis handlers are provider-free and validate detail requests', async () => {
  const model = {
    key: 'pool-analysis:v2', schemaVersion: 2, generatedAt: '2026-01-31T12:00:00Z',
    sourceUpdatedAt: '2026-01-31T12:00:00Z', freshUntil: '2026-01-31T12:20:00Z',
    ageSeconds: 0, stale: false,
    payload: { as_of: '2026-01-31T12:00:00Z', pools: [{ asset: 'BTC.BTC', symbol: 'BTC' }] }
  };
  const summary = await handlePoolAnalysis(null, null, { getReadModel: async () => model });
  assert.equal(summary.status, 200);

  let loadCalls = 0;
  const detail = await handlePoolAnalysisSeries(null, new URL('https://local/pool-analysis-series?asset=BTC.BTC&range=all'), {
    getReadModel: async () => model,
    loadSeries: async (asset) => {
      loadCalls += 1;
      assert.equal(asset, 'BTC.BTC');
      return [{ day: '2026-01-31', volume_rune_e8: '1', volume_usd_e2: '2', fees_rune_e8: '1', rune_price_usd: '1' }];
    }
  });
  assert.equal(detail.status, 200);
  assert.equal(loadCalls, 1);
  const invalid = await handlePoolAnalysisSeries(null, new URL('https://local/pool-analysis-series?asset=BTC.BTC&range=90d'), {
    getReadModel: async () => model
  });
  assert.equal(invalid.status, 400);
});

test('migration, route, jobs, units, deploy, and performance gate encode Pool Analysis', async () => {
  const [migration, feeScopeMigration, server, runJob, timer, service, backfill, deploy, smoke] = await Promise.all([
    readFile(new URL('../migrations/051_pool_analysis.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/052_pool_analysis_fee_scope.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-analysis.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-analysis.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-analysis-backfill.service', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/perf-smoke.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /pool_analysis_daily/);
  assert.match(feeScopeMigration, /drop column if exists pool_earnings_rune_e8/);
  assert.match(feeScopeMigration, /delete from public\.pool_analysis_daily/);
  assert.match(feeScopeMigration, /pool-generated liquidity fees/);
  assert.match(server, /pool-analysis-series/);
  assert.match(runJob, /pool-analysis-backfill/);
  assert.match(timer, /OnUnitActiveSec=15min/);
  assert.match(service, /pool-analysis-scheduler/);
  assert.match(backfill, /pool-analysis-backfill/);
  assert.match(deploy, /boonetools-pool-analysis\.service/);
  assert.match(smoke, /name: 'pool-analysis'/);
});

test('deployment does not roll back when the independently scheduled pool-dislocation repair provider is unavailable', async () => {
  const deploy = await readFile(
    new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url),
    'utf8'
  );
  assert.match(
    deploy,
    /if \[\[ "\$unit" == boonetools-pool-dislocation-repair\.service \]\]; then[\s\S]*?continuing with its cached read model while systemd retries it[\s\S]*?return/
  );
  assert.match(
    deploy,
    /systemctl --failed --no-legend[\s\S]*?grep -Ev '\^boonetools-pool-dislocation-repair\\\.service\$'[\s\S]*?grep -Eq '\^\(boonetools-/
  );
  assert.match(deploy, /--allow-stale-endpoint app-earnings/);
  assert.match(deploy, /--allow-stale-endpoint treasury/);
  assert.match(
    deploy,
    /start_and_verify_timers\nrefresh_status_models_after_long_primes\n\nprime_read_model_unit "boonetools-treasury-snapshot\.service"\n\nlog "Running post-deployment health and performance gates"/
  );
  assert.match(deploy, /OPTIONAL_PRIME_UNIT_PATTERN=.*boonetools-pool-analysis/);
  assert.match(deploy, /OPTIONAL_PRIME_UNIT_PATTERN=.*boonetools-pol-tracker/);
  assert.match(deploy, /OPTIONAL_PRIME_UNIT_PATTERN=.*boonetools-burn-tracker/);
  assert.match(deploy, /OPTIONAL_PRIME_UNIT_PATTERN=.*boonetools-wasm-arb-economics/);
  assert.match(deploy, /systemctl reset-failed "\$unit"/);
  assert.match(deploy, /grep -Ev "\$OPTIONAL_PRIME_UNIT_PATTERN"/);
});
