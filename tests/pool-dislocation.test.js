import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POOL_DISLOCATION_CHART_WINDOWS,
  DEFAULT_POOL_DISLOCATION_SOURCE_MODE,
  POOL_DISLOCATION_ROLLING_MIN_COVERAGE,
  POOL_DISLOCATION_ROLLING_WINDOWS,
  POOL_DISLOCATION_TABLE_COLUMNS,
  buildPoolDislocationLinePath,
  buildPoolDislocationRollingAverage,
  buildPoolDislocationChartScale,
  buildPoolDislocationChartViewport,
  buildPoolDislocationDashboard,
  buildPoolDislocationPreview,
  computeDislocationPercent,
  dislocationState,
  filterPoolDislocationDashboardByTrading,
  isPoolDislocationTickInsideMinimumBand,
  normalizePoolDislocationSeries,
  normalizePoolDislocationSummary,
  projectPoolDislocationChartY,
  projectPoolDislocationChartSelection,
  resolvePoolDislocationSourceMode,
  sortPoolDislocationPools,
  summarizePool,
  summarizePoolDislocation
} from '../src/lib/pool-dislocation/model.js';

test('chart source defaults to both and restores that preference after a single-source pool', () => {
  assert.equal(DEFAULT_POOL_DISLOCATION_SOURCE_MODE, 'both');
  assert.equal(resolvePoolDislocationSourceMode(['both', 'oracle', 'binance']), 'both');
  assert.equal(resolvePoolDislocationSourceMode(['binance']), 'binance');
  assert.equal(resolvePoolDislocationSourceMode(['both', 'oracle', 'binance']), 'both');
  assert.equal(resolvePoolDislocationSourceMode(['oracle'], 'binance'), 'oracle');
  assert.equal(resolvePoolDislocationSourceMode(['both', 'oracle', 'binance'], 'binance'), 'binance');
});

test('chart rolling averages require elapsed windows and minimum exact-point coverage', () => {
  const oneHour = POOL_DISLOCATION_ROLLING_WINDOWS.find((window) => window.id === '1h');
  const startMs = Date.parse('2026-07-29T10:00:00Z');
  const points = Array.from({ length: 20 }, (_, index) => ({
    observedAt: new Date(startMs + (index * 5 * 60 * 1000)).toISOString(),
    oracleDislocation: index,
    binanceDislocation: 0
  }));
  const regular = buildPoolDislocationRollingAverage(points, 'oracleDislocation', {
    durationMs: oneHour.durationMs
  });
  const zeroes = buildPoolDislocationRollingAverage(points, 'binanceDislocation', {
    durationMs: oneHour.durationMs
  });

  assert.deepEqual(POOL_DISLOCATION_ROLLING_WINDOWS.map(({ id, label }) => ({ id, label })), [
    { id: '1h', label: '1H' },
    { id: '6h', label: '6H' },
    { id: '1d', label: '1D' }
  ]);
  assert.equal(regular[11].rollingAverage, null);
  assert.equal(regular[12].rollingAverage, 6);
  assert.equal(regular[12].observedSamples, 13);
  assert.equal(regular[12].expectedSamples, 13);
  assert.equal(regular[12].coverage, 1);
  assert.equal(regular[13].rollingAverage, 7);
  assert.equal(zeroes[12].rollingAverage, 0);

  const missing = buildPoolDislocationRollingAverage(
    points.map((point, index) => index === 6 ? { ...point, oracleDislocation: null } : point),
    'oracleDislocation',
    { durationMs: oneHour.durationMs }
  );
  assert.equal(missing[12].rollingAverage, null);
  assert.equal(missing[18].rollingAverage, null);
  assert.equal(missing[19].rollingAverage, 13);

  const irregular = buildPoolDislocationRollingAverage(
    points.map((point, index) => index === 8
      ? { ...point, observedAt: new Date(Date.parse(point.observedAt) + 60 * 1000).toISOString() }
      : point),
    'oracleDislocation',
    { durationMs: oneHour.durationMs }
  );
  assert.equal(irregular[12].rollingAverage, null);

  const oneDay = POOL_DISLOCATION_ROLLING_WINDOWS.find((window) => window.id === '1d');
  const oneDayPoints = Array.from({ length: 300 }, (_, index) => ({
    observedAt: new Date(startMs + (index * 5 * 60 * 1000)).toISOString(),
    oracleDislocation: index === 120 || index === 180 ? null : 10,
    binanceDislocation: index < 15 ? null : 4
  }));
  const sparseOracle = buildPoolDislocationRollingAverage(oneDayPoints, 'oracleDislocation', oneDay);
  const lowCoverageBinance = buildPoolDislocationRollingAverage(oneDayPoints, 'binanceDislocation', oneDay);

  assert.equal(POOL_DISLOCATION_ROLLING_MIN_COVERAGE, 0.95);
  assert.equal(sparseOracle[288].observedSamples, 287);
  assert.equal(sparseOracle[288].expectedSamples, 289);
  assert.equal(sparseOracle[288].rollingAverage, 10);
  assert.equal(lowCoverageBinance[288].observedSamples, 274);
  assert.equal(lowCoverageBinance[288].rollingAverage, null);
  assert.equal(lowCoverageBinance[299].observedSamples, 285);
  assert.equal(lowCoverageBinance[299].rollingAverage, 4);
});

test('chart paths preserve missing reference values as gaps instead of zeroes', () => {
  const points = [
    { observedAt: '2026-07-29T11:50:00Z', oracleDislocation: 0.25, binanceDislocation: null },
    { observedAt: '2026-07-29T11:55:00Z', oracleDislocation: null, binanceDislocation: null },
    { observedAt: '2026-07-29T12:00:00Z', oracleDislocation: 0, binanceDislocation: null }
  ];
  const options = {
    projectX: (_point, index) => index * 10,
    projectY: (value) => value * 100,
    maximumGapMs: 7.5 * 60 * 1000
  };

  assert.equal(buildPoolDislocationLinePath(points, 'binanceDislocation', options), '');
  assert.equal(
    buildPoolDislocationLinePath(points, 'oracleDislocation', options),
    'M 0.00 25.00 M 20.00 0.00'
  );
});

test('chart scale follows the visible points and selected reference source', () => {
  const quiet = buildPoolDislocationChartScale([
    { oracleDislocation: -0.2, binanceDislocation: 0.4 },
    { oracleDislocation: 0.3, binanceDislocation: 0.5 }
  ], { sourceMode: 'both', threshold: 1 });
  const volatile = buildPoolDislocationChartScale([
    { oracleDislocation: -8.2, binanceDislocation: 0.4 },
    { oracleDislocation: -6.1, binanceDislocation: 0.5 }
  ], { sourceMode: 'oracle', threshold: 1 });
  const binanceOnly = buildPoolDislocationChartScale([
    { oracleDislocation: -8.2, binanceDislocation: 0.4 },
    { oracleDislocation: -6.1, binanceDislocation: 0.5 }
  ], { sourceMode: 'binance', threshold: 1 });
  const differentThreshold = buildPoolDislocationChartScale([
    { oracleDislocation: -0.2, binanceDislocation: 0.4 },
    { oracleDislocation: 0.3, binanceDislocation: 0.5 }
  ], { sourceMode: 'both', threshold: 2 });
  const withMinimumBand = buildPoolDislocationChartScale([
    { oracleDislocation: -0.02, binanceDislocation: 0.03 }
  ], { sourceMode: 'both', threshold: 1, minimumBand: 0.1 });

  assert.ok(quiet.min < -0.2 && quiet.max > 0.5);
  assert.ok((quiet.max - 0.5) / (quiet.max - quiet.min) < 0.05);
  assert.notEqual(quiet.min, -quiet.max);
  assert.ok(volatile.min < -8.2 && volatile.max > 0);
  assert.ok(volatile.max < Math.abs(volatile.min) * 0.1);
  assert.ok(binanceOnly.max > 0.5);
  assert.ok(binanceOnly.max - binanceOnly.min < volatile.max - volatile.min);
  assert.deepEqual(differentThreshold, quiet);
  assert.ok(withMinimumBand.min < -0.1 && withMinimumBand.max > 0.1);
  assert.ok(volatile.ticks.includes(0));
  assert.ok(volatile.ticks.every((tick, index) => index === 0 || tick < volatile.ticks[index - 1]));
});

test('chart scale preserves equal pixels per BPS without centering zero', () => {
  const scale = buildPoolDislocationChartScale([
    { oracleDislocation: -0.9, binanceDislocation: 0.1 },
    { oracleDislocation: 3.1, binanceDislocation: 0.2 }
  ], { sourceMode: 'oracle', threshold: 1, minimumBand: 0.1 });
  const chart = { top: 30, bottom: 456, min: scale.min, max: scale.max };
  const positiveTwentyBps = projectPoolDislocationChartY(0.2, chart);
  const zero = projectPoolDislocationChartY(0, chart);
  const negativeTwentyBps = projectPoolDislocationChartY(-0.2, chart);

  assert.ok(zero > (chart.top + chart.bottom) / 2);
  assert.ok(Math.abs((zero - positiveTwentyBps) - (negativeTwentyBps - zero)) < 1e-9);
});

test('chart guide projection stays pegged to its value when the dynamic scale changes', () => {
  const chart = { top: 30, bottom: 456 };
  const positiveTight = projectPoolDislocationChartY(0.1, {
    ...chart,
    min: -0.3,
    max: 0.12
  });
  const negativeTight = projectPoolDislocationChartY(-0.1, {
    ...chart,
    min: -0.3,
    max: 0.12
  });
  const positiveWide = projectPoolDislocationChartY(0.1, {
    ...chart,
    min: -2,
    max: 3
  });

  assert.ok(positiveTight < negativeTight);
  assert.notEqual(positiveTight, positiveWide);
  assert.equal(projectPoolDislocationChartY(0.12, { ...chart, min: -0.3, max: 0.12 }), chart.top);
  assert.equal(projectPoolDislocationChartY(-0.3, { ...chart, min: -0.3, max: 0.12 }), chart.bottom);
});

test('minimum band axis keeps zero as its only interior tick label', () => {
  assert.equal(isPoolDislocationTickInsideMinimumBand(0, 0.1), false);
  assert.equal(isPoolDislocationTickInsideMinimumBand(0.004, 0.1), true);
  assert.equal(isPoolDislocationTickInsideMinimumBand(-0.099, 0.1), true);
  assert.equal(isPoolDislocationTickInsideMinimumBand(0.1, 0.1), false);
  assert.equal(isPoolDislocationTickInsideMinimumBand(-0.1, 0.1), false);
  assert.equal(isPoolDislocationTickInsideMinimumBand(0.2, 0.1), false);
});

test('chart viewport switches between exact trailing windows and preserves gaps', () => {
  const points = [
    '2026-07-28T12:00:00Z',
    '2026-07-29T10:55:00Z',
    '2026-07-29T11:00:00Z',
    '2026-07-29T12:00:00Z'
  ].map((observedAt) => ({ observedAt }));
  const oneHour = POOL_DISLOCATION_CHART_WINDOWS.find((window) => window.id === '1h');
  const viewport = buildPoolDislocationChartViewport(points, {
    endAt: '2026-07-29T12:00:00Z',
    durationMs: oneHour.durationMs
  });
  assert.equal(new Date(viewport.startMs).toISOString(), '2026-07-29T11:00:00.000Z');
  assert.equal(viewport.expectedSamples, 13);
  assert.deepEqual(viewport.points.map((point) => point.observedAt), [
    '2026-07-29T11:00:00Z',
    '2026-07-29T12:00:00Z'
  ]);
});

test('drag selection projects either direction into a bounded chart zoom', () => {
  const forward = projectPoolDislocationChartSelection({
    plotLeft: 50,
    plotRight: 950,
    startX: 275,
    endX: 725,
    viewportStartMs: 0,
    viewportEndMs: 24 * 60 * 60 * 1000
  });
  const reverse = projectPoolDislocationChartSelection({
    plotLeft: 50,
    plotRight: 950,
    startX: 725,
    endX: 275,
    viewportStartMs: 0,
    viewportEndMs: 24 * 60 * 60 * 1000
  });
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward, {
    startMs: 6 * 60 * 60 * 1000,
    endMs: 18 * 60 * 60 * 1000
  });
  assert.equal(projectPoolDislocationChartSelection({
    plotLeft: 50,
    plotRight: 950,
    startX: 100,
    endX: 104,
    viewportStartMs: 0,
    viewportEndMs: 24 * 60 * 60 * 1000
  }), null);
});

test('every watchlist column sorts deterministically and keeps missing values last', () => {
  const pools = [
    {
      asset: 'BTC.BTC',
      current: { poolPrice: 100, oracleDislocation: -2, binanceDislocation: 1 },
      currentAbsolute: 2,
      averageAbsoluteByWindow: { '1h': 1.5, '4h': 1.4, '1d': 1.3, '3d': 1.2, '7d': 1.1 },
      peakAbsolute: 3,
      hoursOutsideThreshold: 4
    },
    {
      asset: 'ETH.ETH',
      current: { poolPrice: 200, oracleDislocation: 0.5, binanceDislocation: 0.25 },
      currentAbsolute: 0.5,
      averageAbsoluteByWindow: { '1h': 0.4, '4h': 0.5, '1d': 0.6, '3d': 0.7, '7d': 0.8 },
      peakAbsolute: 1,
      hoursOutsideThreshold: 0
    },
    {
      asset: 'AVAX.AVAX',
      current: { poolPrice: null, oracleDislocation: null, binanceDislocation: null },
      currentAbsolute: null,
      averageAbsoluteByWindow: {},
      peakAbsolute: null,
      hoursOutsideThreshold: 0
    }
  ];

  assert.equal(POOL_DISLOCATION_TABLE_COLUMNS.length, 13);
  for (const column of POOL_DISLOCATION_TABLE_COLUMNS) {
    const sorted = sortPoolDislocationPools(pools, {
      column: column.id,
      direction: column.defaultDirection,
      threshold: 1
    });
    assert.equal(sorted.length, pools.length, column.id);
    assert.equal(new Set(sorted.map(({ asset }) => asset)).size, pools.length, column.id);
  }
  assert.deepEqual(
    sortPoolDislocationPools(pools, { column: 'pool', direction: 'asc' }).map(({ asset }) => asset),
    ['AVAX.AVAX', 'BTC.BTC', 'ETH.ETH']
  );
  assert.deepEqual(
    sortPoolDislocationPools(pools, { column: 'oracle', direction: 'asc' }).map(({ asset }) => asset),
    ['BTC.BTC', 'ETH.ETH', 'AVAX.AVAX']
  );
  assert.deepEqual(
    sortPoolDislocationPools(pools, { column: 'state', direction: 'desc', threshold: 1 }).map(({ asset }) => asset),
    ['BTC.BTC', 'ETH.ETH', 'AVAX.AVAX']
  );
});

test('pool dislocation is signed relative to the reference market', () => {
  assert.ok(Math.abs(computeDislocationPercent(101, 100) - 1) < Number.EPSILON * 10);
  assert.ok(Math.abs(computeDislocationPercent(98, 100) - (-2)) < Number.EPSILON * 10);
  assert.equal(computeDislocationPercent(100, 0), null);
  assert.equal(computeDislocationPercent(null, 100), null);
});

test('preview series covers seven days with aligned source observations', () => {
  const pools = buildPoolDislocationPreview();
  assert.equal(pools.length, 12);
  assert.equal(pools[0].points.length, 2017);
  assert.equal(
    Date.parse(pools[0].points.at(-1).observedAt) - Date.parse(pools[0].points[0].observedAt),
    7 * 24 * 60 * 60 * 1000
  );
  assert.ok(pools.every((pool) => pool.points.every((point) => (
    Number.isFinite(point.poolPrice)
      && Number.isFinite(point.oraclePrice)
      && Number.isFinite(point.binancePrice)
  ))));
});

test('pool and dashboard summaries preserve threshold semantics', () => {
  const pool = {
    asset: 'BTC.BTC',
    points: [
      { observedAt: '2026-07-29T09:00:00.000Z', oracleDislocation: 0.2, binanceDislocation: 0.3 },
      { observedAt: '2026-07-29T11:30:00.000Z', oracleDislocation: -1.4, binanceDislocation: -1.2 },
      { observedAt: '2026-07-29T12:00:00.000Z', oracleDislocation: 0.8, binanceDislocation: 1.1 }
    ]
  };
  const summary = summarizePool(pool, 1);
  assert.equal(summary.currentAbsolute, 1.1);
  assert.equal(summary.peakAbsolute, 1.4);
  assert.equal(summary.samplesOutsideThreshold, 2);
  assert.ok(Math.abs(summary.hoursOutsideThreshold - (10 / 60)) < Number.EPSILON);
  assert.equal(summary.averageAbsoluteByWindow['1h'], 1.25);
  assert.ok(Math.abs(summary.averageAbsoluteByWindow['4h'] - (2.8 / 3)) < Number.EPSILON);

  const dashboard = summarizePoolDislocation([pool], 1);
  assert.equal(dashboard.outsideThreshold, 1);
  assert.equal(dashboard.currentLeader.asset, 'BTC.BTC');
});

test('dislocation states separate normal, watch, critical, and missing values', () => {
  assert.equal(dislocationState(0.4, 1), 'normal');
  assert.equal(dislocationState(-1.2, 1), 'watch');
  assert.equal(dislocationState(3.1, 1), 'critical');
  assert.equal(dislocationState(null, 1), 'missing');
  assert.equal(dislocationState(undefined, 1), 'missing');
});

test('production summary normalization preserves source coverage and threshold windows', () => {
  const normalized = normalizePoolDislocationSummary({
    as_of: '2026-07-29T12:00:00Z',
    l1_slip_min_bps: 10,
    coverage: {
      total_pools: 2,
      fully_mapped: 1,
      fully_observed: 1
    },
    chain_trading: {
      known_chains: ['BTC', 'SOL'],
      halted_chains: ['SOL']
    },
    pools: [{
      asset: 'BTC.BTC',
      symbol: 'BTC',
      chain: 'BTC',
      trading_halted: false,
      trading_status_known: true,
      oracle_symbol: 'BTC',
      binance_symbol: 'BTCUSDT',
      latest: {
        observed_at: '2026-07-29T12:00:00Z',
        pool_price_usd: 102,
        oracle_price_usd: 100,
        binance_price_usd: 101,
        oracle_dislocation: 2,
        binance_dislocation: 0.990099
      },
      average_abs: { '1h': 1.2, '4h': 1.1, '1d': 1, '3d': 0.9, '7d': 0.8 },
      peak_abs_7d: 3.2,
      time_outside_hours: { '0.5': 4, '1': 2, '2': 0.5 },
      sparkline: [{ observed_at: '2026-07-29T12:00:00Z', max_abs: 2, oracle_dislocation: 2 }]
    }]
  });
  const dashboard = buildPoolDislocationDashboard(normalized, 1);
  assert.equal(dashboard.coveredPools, 1);
  assert.equal(dashboard.mappedPools, 1);
  assert.equal(dashboard.totalPools, 2);
  assert.equal(dashboard.pools[0].hoursOutsideThreshold, 2);
  assert.equal(dashboard.pools[0].averageAbsoluteByWindow['3d'], 0.9);
  assert.equal(dashboard.pools[0].sparkline[0].oracleDislocation, 2);
  assert.equal(normalized.pools[0].tradingHalted, false);
  assert.equal(normalized.pools[0].tradingStatusKnown, true);
  assert.equal(normalized.l1SlipMinBps, 10);
  assert.deepEqual(normalized.chainTrading.haltedChains, ['SOL']);
});

test('trading filter defaults can remove halted chains and recompute dashboard leaders', () => {
  const dashboard = buildPoolDislocationDashboard({
    coverage: { totalPools: 2, fullyObserved: 2, fullyMapped: 2 },
    pools: [
      {
        asset: 'SOL.SOL',
        symbol: 'SOL',
        chain: 'SOL',
        tradingHalted: true,
        oracleSymbol: 'SOL',
        binanceSymbol: 'SOLUSDT',
        current: { oraclePrice: 100, binancePrice: 100 },
        currentAbsolute: 8,
        peakAbsolute: 9,
        hoursOutsideByThreshold: { '1': 1 }
      },
      {
        asset: 'BTC.BTC',
        symbol: 'BTC',
        chain: 'BTC',
        tradingHalted: false,
        oracleSymbol: 'BTC',
        binanceSymbol: 'BTCUSDT',
        current: { oraclePrice: 100, binancePrice: 100 },
        currentAbsolute: 2,
        peakAbsolute: 3,
        hoursOutsideByThreshold: { '1': 0.5 }
      }
    ]
  }, 1);
  const filtered = filterPoolDislocationDashboardByTrading(dashboard);
  assert.deepEqual(filtered.pools.map((pool) => pool.asset), ['BTC.BTC']);
  assert.equal(filtered.totalPools, 1);
  assert.equal(filtered.availablePools, 2);
  assert.equal(filtered.hiddenHaltedPools, 1);
  assert.deepEqual(filtered.haltedChains, ['SOL']);
  assert.equal(filtered.currentLeader.asset, 'BTC.BTC');
  assert.equal(filtered.peakLeader.asset, 'BTC.BTC');
  assert.equal(filtered.outsideThreshold, 1);

  const included = filterPoolDislocationDashboardByTrading(dashboard, false);
  assert.equal(included.totalPools, 2);
  assert.equal(included.hiddenHaltedPools, 0);
  assert.equal(included.currentLeader.asset, 'SOL.SOL');
});

test('production selected series retains null source gaps and exact timestamps', () => {
  const series = normalizePoolDislocationSeries({
    asset: 'BTC.BTC',
    expected_samples: 2017,
    provenance: {
      scheduled_samples: 1,
      backfilled_samples: 1,
      pool_price_methods: ['thornode-asset-tor'],
      oracle_price_methods: ['thornode-oracle'],
      binance_price_methods: ['book-ticker-mid', 'kline-close']
    },
    points: [
      {
        observed_at: '2026-07-29T11:55:00Z',
        pool_price_usd: 101,
        oracle_price_usd: 100,
        binance_price_usd: 100,
        sample_origin: 'historical_backfill',
        thorchain_height: 123,
        binance_price_method: 'kline-close'
      },
      {
        observed_at: '2026-07-29T12:00:00Z',
        pool_price_usd: 101,
        oracle_price_usd: null,
        binance_price_usd: 100
      }
    ]
  });
  assert.equal(series.points.length, 2);
  assert.equal(series.points[1].observedAt, '2026-07-29T12:00:00Z');
  assert.equal(series.points[1].oracleDislocation, null);
  assert.ok(Math.abs(series.points[1].binanceDislocation - 1) < Number.EPSILON * 10);
  assert.equal(series.points[0].sampleOrigin, 'historical_backfill');
  assert.equal(series.points[0].thorchainHeight, 123);
  assert.equal(series.points[0].binancePriceMethod, 'kline-close');
  assert.equal(series.provenance.backfilledSamples, 1);
});
