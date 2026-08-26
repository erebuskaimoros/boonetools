import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  POOL_ANALYSIS_COLUMNS,
  POOL_ANALYSIS_RANGES,
  POOL_ANALYSIS_TABLE_PERIODS,
  filterPoolAnalysisRows,
  normalizePoolAnalysisSeries,
  normalizePoolAnalysisSummary,
  poolAnalysisColumns,
  selectPoolAnalysisPeriod,
  sortPoolAnalysisRows
} from '../src/lib/pool-analysis/model.js';

function samplePayload() {
  return {
    as_of: '2026-08-25T12:00:00Z',
    period: { id: '30d', days: 30, through_day: '2026-08-24' },
    pools: [
      {
        asset: 'BTC.BTC', chain: 'BTC', symbol: 'BTC', status: 'Available',
        price_usd: 80000, oracle_price_usd: 79000, oracle_deviation_percent: 1.2,
        depth_usd: 5000000, total_depth_usd: 10000000,
        balance_asset_e8: '10000000000', balance_rune_e8: '200000000000000',
        volume_24h_usd: 1000000, period_volume_usd: 30000000, period_fees_usd: 300000,
        volume_depth_percent: 20, fee_volume_percent: 1,
        annualized_fees_usd: 3650000, annualized_fee_rate_percent: 36.5,
        coverage: { observed_days: 30, expected_days: 30, missing_days: 0 },
        period_metrics: {
          '24h': {
            id: '24h', days: 1, volume_rune_e8: '100', volume_usd: 1000000,
            fees_rune_e8: '1', fees_usd: 10000, fee_volume_percent: 1,
            volume_depth_percent: 5, annualized_fees_usd: 3650000,
            annualized_fee_rate_percent: 36.5,
            coverage: { observed_days: 1, expected_days: 1, missing_days: 0 }
          },
          '90d': {
            id: '90d', days: 90, volume_rune_e8: '9000', volume_usd: 90000000,
            fees_rune_e8: '90', fees_usd: 900000, fee_volume_percent: 1,
            volume_depth_percent: 45, annualized_fees_usd: 3650000,
            annualized_fee_rate_percent: 36.5,
            coverage: { observed_days: 90, expected_days: 90, missing_days: 0 }
          }
        }
      },
      {
        asset: 'ETH.ETH', chain: 'ETH', symbol: 'ETH', status: 'Staged',
        price_usd: 2000, depth_usd: 1000000, annualized_fees_usd: null,
        coverage: { observed_days: 10, expected_days: 30, missing_days: 20 }
      }
    ]
  };
}

test('Pool Analysis normalizes, filters, and keeps missing sort values last in both directions', () => {
  const dashboard = normalizePoolAnalysisSummary(samplePayload());
  assert.equal(dashboard.pools[0].balanceRuneBase, '200000000000000');
  assert.equal(dashboard.pools[0].depthUsd, 10000000);
  assert.equal(dashboard.pools[1].depthUsd, 2000000);
  assert.deepEqual(filterPoolAnalysisRows(dashboard.pools, { status: 'available' }).map((row) => row.asset), ['BTC.BTC']);
  assert.deepEqual(filterPoolAnalysisRows(dashboard.pools, { status: 'all', search: 'eth' }).map((row) => row.asset), ['ETH.ETH']);
  for (const direction of ['asc', 'desc']) {
    assert.equal(sortPoolAnalysisRows(dashboard.pools, {
      column: 'annualizedFeeRatePercent', direction
    }).at(-1).asset, 'ETH.ETH');
  }
  assert.deepEqual(sortPoolAnalysisRows(dashboard.pools, {
    column: 'asset', direction: 'asc'
  }).map((row) => row.asset), ['BTC.BTC', 'ETH.ETH']);
});

test('Pool Analysis upgrades legacy one-sided summary fields to two-sided table values', () => {
  const dashboard = normalizePoolAnalysisSummary({
    pools: [{
      asset: 'ETH.ETH', status: 'Available', depth_usd: 100,
      period_metrics: {
        '30d': {
          volume_depth_percent: 20,
          coverage: { observed_days: 30, expected_days: 30, missing_days: 0 }
        }
      }
    }]
  });
  assert.equal(dashboard.pools[0].depthUsd, 200);
  assert.equal(dashboard.pools[0].periodMetrics['30d'].volumeDepthPercent, 10);
});

test('Pool Analysis exposes exactly the consolidated semantic columns and requested chart ranges', () => {
  assert.deepEqual(POOL_ANALYSIS_RANGES, [
    { id: '30d', label: '30D' },
    { id: 'all', label: 'ALL TIME' }
  ]);
  assert.deepEqual(POOL_ANALYSIS_TABLE_PERIODS, [
    { id: '24h', label: '24H', days: 1 },
    { id: '7d', label: '7D', days: 7 },
    { id: '30d', label: '30D', days: 30 },
    { id: '90d', label: '90D', days: 90 },
    { id: '1y', label: '1Y', days: 365 }
  ]);
  assert.deepEqual(poolAnalysisColumns('90d').map((column) => column.label), [
    'POOL', 'USD PRICE', 'ORACLE', 'DEPTH', 'BALANCES',
    'VOLUME', 'FEES', 'VOLUME / DEPTH',
    'FEES / VOLUME', 'EST APR'
  ]);
  assert.equal(POOL_ANALYSIS_COLUMNS.some((column) => column.id === 'annualizedFeesUsd'), false);
  assert.equal(POOL_ANALYSIS_COLUMNS.some((column) => column.id === 'volume24hUsd'), false);
  assert.equal(POOL_ANALYSIS_COLUMNS.filter((column) => column.label === 'VOLUME').length, 1);
  assert.equal(POOL_ANALYSIS_COLUMNS.some((column) => column.id === 'actions'), false);
  assert.equal(POOL_ANALYSIS_COLUMNS.some((column) => /POOL EARNINGS/.test(column.label)), false);
});

test('Pool Analysis applies one selected period to every activity value in a row', () => {
  const pool = normalizePoolAnalysisSummary(samplePayload()).pools[0];
  const daily = selectPoolAnalysisPeriod(pool, '24h');
  const quarterly = selectPoolAnalysisPeriod(pool, '90d');
  assert.equal(daily.periodVolumeUsd, 1000000);
  assert.equal(daily.periodFeesUsd, 10000);
  assert.equal(daily.volumeDepthPercent, 5);
  assert.equal(daily.coverage.expectedDays, 1);
  assert.equal(quarterly.periodVolumeUsd, 90000000);
  assert.equal(quarterly.periodFeesUsd, 900000);
  assert.equal(quarterly.volumeDepthPercent, 45);
  assert.equal(quarterly.coverage.expectedDays, 90);
});

test('Pool Analysis series preserves gaps, partial state, exact RUNE, and cumulative anchors', () => {
  const series = normalizePoolAnalysisSeries({
    asset: 'BTC.BTC', range: '30d',
    points: [
      {
        day: '2026-08-23', volume_rune_e8: '200000000', volume_usd: 10,
        fees_rune_e8: '100000000', fees_usd: 2,
        cumulative_fees_rune_e8: '9007199254740993', cumulative_fees_usd: 100
      },
      {
        day: '2026-08-24', volume_rune_e8: null, fees_rune_e8: null,
        cumulative_fees_rune_e8: null, source: 'missing'
      },
      {
        day: '2026-08-25', volume_rune_e8: '1', fees_rune_e8: '1',
        cumulative_fees_rune_e8: '9007199254740994', partial: true
      }
    ],
    coverage: { first_indexed_day: '2021-04-11', missing_days: ['2026-08-24'] }
  });
  assert.equal(series.points[0].volumeRune, 2);
  assert.equal(series.points[0].cumulativeFeesRuneBase, '9007199254740993');
  assert.equal(series.points[1].feesRune, null);
  assert.equal(series.points[2].partial, true);
  assert.equal(series.coverage.firstIndexedDay, '2021-04-11');
});

test('Pool Analysis is routed, accessible, lazy, zoomable, and omits the excluded raw columns', async () => {
  const [app, component, chart] = await Promise.all([
    readFile(new URL('../src/App.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/PoolAnalysis.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/pool-analysis/charts.js', import.meta.url), 'utf8')
  ]);
  const visibleApps = app.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';
  assert.match(app, /path: "pool-analysis"/);
  assert.equal(visibleApps.includes('poolAnalysisApp'), false);
  assert.match(app, /const hiddenApps = \[wasmArbEconomicsApp, poolAnalysisApp\];/);
  assert.match(app, /return \[\.\.\.apps, \.\.\.hiddenApps\]\.find/);
  assert.match(component, /aria-expanded=/);
  assert.match(component, /aria-controls=/);
  assert.match(component, /colspan=\{tableColumns\.length\}/);
  assert.match(component, /fetchPoolAnalysisSeries/);
  assert.match(component, /DRAG TO ZOOM/);
  assert.match(component, /Keyboard zoom controls/);
  assert.match(component, /aria-label="Table activity period"/);
  assert.match(component, /FIRST INDEXED/);
  for (const excluded of ['TRADE ASSET DEPTH', 'RUNEPOOL SHARE', 'POOL EARNINGS', 'DISTRIBUTED', 'EST YR SWAP FEES']) {
    assert.equal(component.toUpperCase().includes(excluded), false, excluded);
  }
  assert.equal((component.match(/<canvas\b/g) || []).length, 1);
  assert.match(component, /class="chart-frame"/);
  assert.match(component, /\.table-scroll \{[^}]*container-type: inline-size;/);
  assert.doesNotMatch(component, /min-width: 1480px/);
  assert.match(component, /table \{[^}]*min-width: 1000px;[^}]*table-layout: fixed;/);
  assert.match(component, /@container \(max-width: 900px\)/);
  assert.match(component, /data-label="USD PRICE"/);
  assert.match(component, /data-label="VOLUME"/);
  assert.match(component, /data-label="FEES"/);
  assert.match(component, /Pricing and two-sided depth are current/);
  assert.doesNotMatch(component, /data-label=\{`(?:VOLUME|FEES) · \$\{tablePeriod\.label\}`\}/);
  assert.match(component, /FEES = POOL-GENERATED LIQUIDITY FEES/);
  assert.match(component, /SYSTEM-INCOME DISTRIBUTION OUT OF SCOPE/);
  assert.doesNotMatch(component, /app\.thorswap\.finance/);
  assert.match(component, /\.detail-panel \{[^}]*width: 100cqw;[^}]*max-width: 100cqw;/);
  assert.match(chart, /label: 'DAILY VOLUME'/);
  assert.match(chart, /label: 'DAILY FEES'/);
  assert.match(chart, /label: 'CUMULATIVE FEES'/);
  assert.match(chart, /wheel: \{ enabled: false \}/);
  assert.match(chart, /pinch: \{ enabled: true \}/);
  assert.match(chart, /cumulativeFeesUsd/);
});
