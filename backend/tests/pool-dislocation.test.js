import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  POOL_DISLOCATION_MODEL_KEY,
  applyPoolDislocationTradingStatus,
  binanceSymbolsForPools,
  buildObservationRows,
  buildPoolDislocationSeries,
  buildPoolDislocationSummary,
  floorToFiveMinuteBucket,
  normalizeBinanceBookTickers,
  normalizeChainTradingStatus,
  normalizeOraclePrices,
  referenceMappingForAsset
} from '../src/shared/pool-dislocation.js';
import {
  collectPoolDislocationSnapshot,
  loadPoolTradingStatus,
  resolvePoolDislocationCorePoolFallback,
  retryPoolDislocationSnapshotOperation,
  runPoolDislocationScheduler
} from '../src/jobs/pool-dislocation-scheduler.js';
import {
  handlePoolDislocation,
  handlePoolDislocationSeries
} from '../src/handlers/pool-dislocation.js';

const AVAILABLE_POOLS = [
  {
    asset: 'BTC.BTC',
    status: 'Available',
    asset_tor_price: '10100000000',
    balance_asset: '100',
    balance_rune: '200'
  },
  {
    asset: 'ETH.UNKNOWN-0XABC',
    status: 'Available',
    asset_tor_price: '500000000',
    balance_asset: '300',
    balance_rune: '400'
  },
  {
    asset: 'ETH.ETH',
    status: 'Staged',
    asset_tor_price: '200000000000'
  }
];

test('five-minute buckets and reference mappings are exact and auditable', () => {
  assert.equal(floorToFiveMinuteBucket('2026-07-29T12:07:59.999Z'), '2026-07-29T12:05:00.000Z');
  assert.deepEqual(referenceMappingForAsset('btc.btc'), { oracle: 'BTC', binance: 'BTCUSDT' });
  assert.deepEqual(
    referenceMappingForAsset('ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599'),
    { oracle: 'BTC', binance: 'WBTCUSDT' }
  );
  for (const asset of [
    'AVAX.SOL-0XFE6B19286885A4F7F55ADAD09C3CD1F906D2478F',
    'BSC.BTCB-0X7130D2A12B9BCBFAE4F2634D864A1EE1CE3EAD9C',
    'BSC.ETH-0X2170ED0880AC9A755FD29B2688956BD959F933F8',
    'BSC.USDC-0X8AC76A51CC950D9822D68B83FE1AD97B32CD580D'
  ]) {
    assert.equal(referenceMappingForAsset(asset).binance, null);
  }
  assert.deepEqual(binanceSymbolsForPools([
    { asset: 'ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599' },
    { asset: 'BSC.BTCB-0X7130D2A12B9BCBFAE4F2634D864A1EE1CE3EAD9C' },
    { asset: 'AVAX.SOL-0XFE6B19286885A4F7F55ADAD09C3CD1F906D2478F' }
  ]), ['WBTCUSDT']);
  assert.deepEqual(referenceMappingForAsset('ETH.UNKNOWN-0XABC'), { oracle: null, binance: null });
  assert.deepEqual(binanceSymbolsForPools(AVAILABLE_POOLS), ['BTCUSDT', 'ETHUSDT']);
});

test('provider payload normalization rejects unusable prices and spreads', () => {
  const oracle = normalizeOraclePrices({ prices: [
    { symbol: 'BTC', price: '100' },
    { symbol: 'BAD', price: '0' }
  ] });
  const binance = normalizeBinanceBookTickers([
    { symbol: 'BTCUSDT', bidPrice: '99', askPrice: '101' },
    { symbol: 'BADUSDT', bidPrice: '3', askPrice: '2' }
  ]);
  assert.equal(oracle.get('BTC'), 100);
  assert.equal(oracle.has('BAD'), false);
  assert.deepEqual(binance.get('BTCUSDT'), { bid: 99, ask: 101, mid: 100 });
  assert.equal(binance.has('BADUSDT'), false);
});

test('chain trading status treats halt, chain pause, and global pause as trading halts', () => {
  const status = normalizeChainTradingStatus([
    { chain: 'BTC', halted: false, global_trading_paused: false, chain_trading_paused: false },
    { chain: 'SOL', halted: true, global_trading_paused: false, chain_trading_paused: true },
    { chain: 'ETH', halted: 'false', global_trading_paused: 'false', chain_trading_paused: 'false' }
  ]);
  assert.deepEqual(status.known_chains, ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(status.halted_chains, ['SOL']);
  assert.equal(status.chains.BTC.trading_halted, false);
  assert.equal(status.chains.SOL.trading_halted, true);

  const global = normalizeChainTradingStatus([
    { chain: 'BTC', global_trading_paused: true },
    { chain: 'ETH', global_trading_paused: false }
  ]);
  assert.deepEqual(global.halted_chains, ['BTC', 'ETH']);
});

test('current chain trading status replaces sampled pool flags without mutating price data', () => {
  const summary = {
    pools: [
      { asset: 'BTC.BTC', chain: 'BTC', latest: { pool_price_usd: 100 }, trading_halted: true },
      { asset: 'SOL.SOL', chain: 'SOL', latest: { pool_price_usd: 50 }, trading_halted: false }
    ]
  };
  const overlaid = applyPoolDislocationTradingStatus(summary, normalizeChainTradingStatus([
    { chain: 'BTC', chain_trading_paused: false },
    { chain: 'SOL', chain_trading_paused: true }
  ]));

  assert.equal(overlaid.pools[0].latest.pool_price_usd, 100);
  assert.equal(overlaid.pools[0].trading_halted, false);
  assert.equal(overlaid.pools[0].trading_status_known, true);
  assert.equal(overlaid.pools[1].trading_halted, true);
  assert.equal(summary.pools[0].trading_halted, true);
});

test('chain trading status is sourced from the canonical durable THORNode snapshot', async () => {
  const inboundAddresses = [{ chain: 'BTC', chain_trading_paused: false }];
  const coreModel = {
    stale: false,
    payload: {
      inbound_addresses: inboundAddresses,
      field_meta: { inbound_addresses: { status: 'fresh' } }
    }
  };
  assert.equal(await loadPoolTradingStatus({
    client: { name: 'client' },
    getThorNodeCoreSnapshot: async (options) => {
      assert.equal(options.cache, false);
      assert.equal(options.allowStale, true);
      return coreModel;
    }
  }), inboundAddresses);
  await assert.rejects(
    loadPoolTradingStatus({
      getThorNodeCoreSnapshot: async () => ({ ...coreModel, stale: true })
    }),
    /unavailable or stale/
  );
});

test('observation rows retain every Available pool and null unaligned references', () => {
  const aligned = buildObservationRows({
    pools: AVAILABLE_POOLS,
    oraclePrices: new Map([['BTC', 100]]),
    binanceTickers: new Map([['BTCUSDT', { bid: 99, ask: 101, mid: 100 }]]),
    observedAt: '2026-07-29T12:07:00Z',
    poolObservedAt: '2026-07-29T12:07:01Z',
    oracleObservedAt: '2026-07-29T12:07:02Z',
    binanceObservedAt: '2026-07-29T12:07:03Z'
  });
  assert.equal(aligned.length, 2);
  assert.equal(aligned[0].observedAt, '2026-07-29T12:05:00.000Z');
  assert.equal(aligned[0].poolPriceUsd, 101);
  assert.equal(aligned[0].oraclePriceUsd, 100);
  assert.equal(aligned[0].binancePriceUsd, 100);
  assert.equal(aligned[0].sourceSkewMs, 2000);
  assert.equal(aligned[1].oraclePriceUsd, null);

  const skewed = buildObservationRows({
    pools: AVAILABLE_POOLS.slice(0, 1),
    oraclePrices: new Map([['BTC', 100]]),
    binanceTickers: new Map([['BTCUSDT', { bid: 99, ask: 101, mid: 100 }]]),
    observedAt: '2026-07-29T12:05:00Z',
    poolObservedAt: '2026-07-29T12:05:00Z',
    oracleObservedAt: '2026-07-29T12:06:00Z',
    binanceObservedAt: '2026-07-29T12:05:02Z'
  });
  assert.equal(skewed[0].sourceSkewMs, 60_000);
  assert.equal(skewed[0].oraclePriceUsd, null);
  assert.equal(skewed[0].binancePriceUsd, 100);
});

test('summary uses every five-minute sample for windows and hourly peak-preserving sparklines', () => {
  const rows = [
    ['2026-07-29T08:00:00Z', 100],
    ['2026-07-29T11:05:00Z', 101],
    ['2026-07-29T11:55:00Z', 104],
    ['2026-07-29T12:00:00Z', 102]
  ].map(([observed_at, pool_price_usd]) => ({
    observed_at,
    asset: 'BTC.BTC',
    symbol: 'BTC',
    chain: 'BTC',
    pool_status: 'Available',
    pool_price_usd,
    oracle_symbol: 'BTC',
    oracle_price_usd: 100,
    binance_symbol: 'BTCUSDT',
    binance_price_usd: 100
  }));
  const summary = buildPoolDislocationSummary(rows, {
    asOf: '2026-07-29T12:00:00Z',
    chainTrading: normalizeChainTradingStatus([
      { chain: 'BTC', chain_trading_paused: true }
    ])
  });
  const pool = summary.pools[0];
  assert.equal(summary.expected_samples, 2017);
  assert.ok(Math.abs(pool.average_abs['1h'] - (7 / 3)) < 1e-9);
  assert.ok(Math.abs(pool.average_abs['4h'] - 1.75) < 1e-9);
  assert.ok(Math.abs(pool.peak_abs_7d - 4) < 1e-9);
  assert.ok(Math.abs(pool.time_outside_hours['1'] - (15 / 60)) < 1e-9);
  assert.equal(pool.sparkline.length, 3);
  assert.ok(Math.abs(pool.sparkline[1].max_abs - 4) < 1e-9);
  assert.equal(pool.trading_halted, true);
  assert.equal(pool.trading_status_known, true);
});

test('summary limits historical groups to the current Available pool set', () => {
  const rows = ['BTC.BTC', 'ETH.ETH'].map((asset) => ({
    observed_at: '2026-07-29T12:00:00Z',
    asset,
    symbol: asset.split('.')[1],
    chain: asset.split('.')[0],
    pool_status: 'Available',
    pool_price_usd: 100,
    sample_origin: 'historical_backfill',
    pool_price_method: 'thornode-asset-tor'
  }));
  const summary = buildPoolDislocationSummary(rows, {
    asOf: '2026-07-29T12:00:00Z',
    currentAssets: ['BTC.BTC']
  });
  assert.deepEqual(summary.pools.map((pool) => pool.asset), ['BTC.BTC']);
  assert.equal(summary.pools[0].samples.backfilled, 1);
  assert.equal(summary.provenance.backfilled_observations, 1);
});

test('selected series returns exact ordered points without interpolation', () => {
  const rows = [{
    observed_at: '2026-07-29T12:00:00Z',
    asset: 'BTC.BTC',
    symbol: 'BTC',
    chain: 'BTC',
    pool_price_usd: 101,
    oracle_symbol: 'BTC',
    oracle_price_usd: null,
    binance_symbol: 'BTCUSDT',
    binance_price_usd: 100
  }];
  const series = buildPoolDislocationSeries(rows, { asset: 'BTC.BTC' });
  assert.equal(series.points.length, 1);
  assert.equal(series.points[0].oracle_dislocation, null);
  assert.ok(Math.abs(series.points[0].binance_dislocation - 1) < 1e-9);
});

test('collector degrades a failed reference source while preserving pool observations', async () => {
  const times = [
    new Date('2026-07-29T12:07:01Z'),
    new Date('2026-07-29T12:07:02Z'),
    new Date('2026-07-29T12:07:03Z'),
    new Date('2026-07-29T12:07:04Z')
  ];
  const snapshot = await collectPoolDislocationSnapshot({
    now: () => times.shift() || new Date('2026-07-29T12:07:04Z'),
    fetchPools: async () => AVAILABLE_POOLS,
    fetchOracle: async () => { throw new Error('oracle offline'); },
    fetchBinance: async () => [{ symbol: 'BTCUSDT', bidPrice: '99', askPrice: '101' }],
    fetchInboundAddresses: async () => [
      { chain: 'BTC', halted: false, global_trading_paused: false, chain_trading_paused: false }
    ]
  });
  assert.equal(snapshot.observedAt, '2026-07-29T12:05:00.000Z');
  assert.equal(snapshot.sources.oracle.status, 'error');
  assert.equal(snapshot.rows[0].oraclePriceUsd, null);
  assert.equal(snapshot.rows[0].binancePriceUsd, 100);
  assert.equal(snapshot.sources.trading.status, 'fresh');
  assert.equal(snapshot.sources.trading.provider, 'thornode-core-snapshot');
  assert.deepEqual(snapshot.chainTrading.halted_chains, []);
  assert.match(snapshot.warnings[0], /oracle offline/);
});

test('required pool snapshots retry transient failures outside a shared cooldown', async () => {
  const contexts = [];
  const delays = [];
  const result = await retryPoolDislocationSnapshotOperation(async (context) => {
    contexts.push(context);
    if (context.attempt < 3) throw new TypeError('fetch failed');
    return AVAILABLE_POOLS;
  }, {
    attempts: 3,
    baseDelayMs: 25,
    sleep: async (delayMs) => delays.push(delayMs)
  });
  assert.equal(result, AVAILABLE_POOLS);
  assert.deepEqual(contexts, [
    { attempt: 1, bypassSharedCooldown: false },
    { attempt: 2, bypassSharedCooldown: true },
    { attempt: 3, bypassSharedCooldown: true }
  ]);
  assert.deepEqual(delays, [25, 50]);
});

test('core pool fallback accepts only fresh independently persisted snapshots', () => {
  const snapshot = {
    payload: {
      pools: AVAILABLE_POOLS,
      field_meta: { pools: { fetched_at: '2026-07-29T12:04:00Z' } }
    }
  };
  assert.deepEqual(resolvePoolDislocationCorePoolFallback(snapshot, {
    observedAt: '2026-07-29T12:05:00Z',
    maxAgeMs: 90_000
  }), {
    pools: AVAILABLE_POOLS,
    observedAt: '2026-07-29T12:04:00.000Z',
    ageMs: 60_000
  });
  assert.equal(resolvePoolDislocationCorePoolFallback(snapshot, {
    observedAt: '2026-07-29T12:05:31Z',
    maxAgeMs: 90_000
  }), null);
});

test('collector writes a provenance-labelled bucket from the durable core fallback', async () => {
  const attempts = [];
  const snapshot = await collectPoolDislocationSnapshot({
    now: () => new Date('2026-07-29T12:05:02Z'),
    snapshotRetryAttempts: 2,
    snapshotRetryBaseDelayMs: 0,
    snapshotRetrySleep: async () => {},
    fetchPools: async (context) => {
      attempts.push(context);
      throw new TypeError('fetch failed');
    },
    getThorNodeCoreSnapshot: async () => ({
      payload: {
        pools: AVAILABLE_POOLS,
        field_meta: { pools: { fetched_at: '2026-07-29T12:04:50Z' } }
      }
    }),
    fetchOracle: async () => ({ prices: [{ symbol: 'BTC', price: '100' }] }),
    fetchBinance: async () => [{ symbol: 'BTCUSDT', bidPrice: '99', askPrice: '101' }],
    fetchInboundAddresses: async () => []
  });
  assert.deepEqual(attempts.map(({ bypassSharedCooldown }) => bypassSharedCooldown), [false, true]);
  assert.equal(snapshot.sources.pool.status, 'cached');
  assert.equal(snapshot.sources.pool.provider, 'thornode-core-snapshot');
  assert.equal(snapshot.sources.pool.age_ms, 12_000);
  assert.equal(snapshot.rows[0].poolPriceMethod, 'thornode-core-snapshot');
  assert.equal(snapshot.rows[0].oraclePriceUsd, 100);
  assert.equal(snapshot.rows[0].binancePriceUsd, 100);
  assert.match(snapshot.warnings[0], /pool: fetch failed/);
});

test('scheduler owns one isolated lock and publishes the resulting read model', async () => {
  let lockKey = '';
  let publishOptions;
  const result = await runPoolDislocationScheduler({
    lockRunner: async (key, callback) => {
      lockKey = key;
      return callback({ name: 'client' });
    },
    publish: async (options) => {
      publishOptions = options;
      const built = await options.build();
      return { ok: true, runId: '4', model: { key: options.modelKey, ...built } };
    },
    collect: async () => ({
      observedAt: '2026-07-29T12:05:00Z',
      rows: [{ asset: 'BTC.BTC' }],
      sources: {},
      warnings: []
    }),
    persist: async () => {},
    loadWindow: async () => []
  });
  assert.equal(lockKey, 'boonetools:pool-dislocation');
  assert.equal(publishOptions.modelKey, POOL_DISLOCATION_MODEL_KEY);
  assert.equal(result.ok, true);
});

test('public handlers are provider-free and the series query is bounded', async () => {
  const model = {
    key: POOL_DISLOCATION_MODEL_KEY,
    payload: {
      as_of: '2026-07-29T12:05:00Z',
      pools: [
        { asset: 'BTC.BTC', chain: 'BTC', trading_halted: true, trading_status_known: true },
        { asset: 'SOL.SOL', chain: 'SOL', trading_halted: false, trading_status_known: false }
      ],
      sources: {
        trading: { status: 'error', error: 'sampled trading state failed' }
      },
      warnings: ['oracle: unavailable', 'trading: sampled trading state failed']
    },
    etag: '"summary"',
    generatedAt: '2026-07-29T12:05:00Z',
    sourceUpdatedAt: '2026-07-29T12:05:00Z',
    freshUntil: '2026-07-29T12:20:00Z',
    ageSeconds: 3,
    stale: false
  };
  const summaryResponse = await handlePoolDislocation({ headers: {} }, null, {
    getReadModel: async () => model,
    getThorNodeCoreSnapshot: async (options) => {
      assert.equal(options.allowStale, true);
      return {
        stale: false,
        etag: '"core"',
        payload: {
          inbound_addresses: [
            { chain: 'BTC', chain_trading_paused: false },
            { chain: 'SOL', chain_trading_paused: true }
          ],
          field_meta: {
            inbound_addresses: {
              status: 'fresh',
              fetched_at: '2026-07-29T12:06:00Z'
            }
          }
        }
      };
    }
  });
  assert.equal(summaryResponse.status, 200);
  assert.equal(summaryResponse.body.as_of, model.payload.as_of);
  assert.deepEqual(summaryResponse.body.chain_trading.halted_chains, ['SOL']);
  assert.equal(summaryResponse.body.pools[0].trading_halted, false);
  assert.equal(summaryResponse.body.pools[0].trading_status_known, true);
  assert.equal(summaryResponse.body.pools[1].trading_halted, true);
  assert.equal(summaryResponse.body.sources.trading.status, 'fresh');
  assert.equal(summaryResponse.body.sources.trading.observed_at, '2026-07-29T12:06:00Z');
  assert.deepEqual(summaryResponse.body.warnings, ['oracle: unavailable']);
  assert.notEqual(summaryResponse.headers.ETag, model.etag);

  let sql = '';
  let params;
  const seriesResponse = await handlePoolDislocationSeries(
    { headers: {} },
    new URL('http://localhost/pool-dislocation-series?asset=btc.btc'),
    {
      getReadModel: async () => model,
      query: async (statement, values) => {
        sql = statement;
        params = values;
        return { rows: [] };
      }
    }
  );
  assert.equal(seriesResponse.status, 200);
  assert.match(sql, /interval '7 days'/);
  assert.match(sql, /limit 2017/i);
  assert.deepEqual(params, ['BTC.BTC', model.payload.as_of]);

  const missing = await handlePoolDislocationSeries(
    { headers: {} },
    new URL('http://localhost/pool-dislocation-series?asset=ETH.ETH'),
    { getReadModel: async () => model, query: async () => assert.fail('must not query') }
  );
  assert.equal(missing.status, 404);
});

test('summary fails open only when current durable trading state is unavailable', async () => {
  const model = {
    key: POOL_DISLOCATION_MODEL_KEY,
    payload: {
      as_of: '2026-07-29T12:05:00Z',
      pools: [{
        asset: 'SOL.SOL',
        chain: 'SOL',
        trading_halted: true,
        trading_status_known: true
      }],
      chain_trading: normalizeChainTradingStatus([{ chain: 'SOL', chain_trading_paused: true }]),
      sources: { trading: { status: 'fresh' } },
      warnings: []
    },
    etag: '"summary"',
    generatedAt: '2026-07-29T12:05:00Z',
    sourceUpdatedAt: '2026-07-29T12:05:00Z',
    freshUntil: '2026-07-29T12:20:00Z',
    ageSeconds: 3,
    stale: false
  };
  const response = await handlePoolDislocation({ headers: {} }, null, {
    getReadModel: async () => model,
    getThorNodeCoreSnapshot: async () => ({
      stale: true,
      payload: {
        inbound_addresses: [{ chain: 'SOL', chain_trading_paused: true }],
        field_meta: { inbound_addresses: { status: 'reused' } }
      }
    })
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.pools[0].trading_halted, false);
  assert.equal(response.body.pools[0].trading_status_known, false);
  assert.equal(response.body.sources.trading.status, 'error');
  assert.match(response.body.warnings[0], /Current THORNode inbound-address state is unavailable or stale/);
  assert.match(response.headers['Cache-Control'], /max-age=15/);
});

test('migration, job registry, timer, and deploy encode the production contract', async () => {
  const [
    migration,
    provenanceMigration,
    referenceCorrectionMigration,
    registry,
    service,
    backfillService,
    repairService,
    timer,
    repairTimer,
    deploy
  ] = await Promise.all([
    readFile(new URL('../migrations/031_pool_dislocation.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/033_pool_dislocation_provenance.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/034_pool_dislocation_exact_binance_markets.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-dislocation.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-dislocation-backfill.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-dislocation-repair.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-dislocation.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pool-dislocation-repair.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /primary key \(observed_at, asset\)/i);
  assert.match(provenanceMigration, /historical_backfill/);
  assert.match(provenanceMigration, /kline-close/);
  assert.match(referenceCorrectionMigration, /WBTCUSDT/);
  assert.match(referenceCorrectionMigration, /BSC\.BTCB/);
  assert.match(referenceCorrectionMigration, /binance_price_usd = null/);
  assert.match(registry, /'pool-dislocation-backfill': runPoolDislocationBackfill/);
  assert.match(registry, /'pool-dislocation-repair': runPoolDislocationRepair/);
  assert.match(registry, /'pool-dislocation-scheduler': runPoolDislocationScheduler/);
  assert.match(service, /pool-dislocation-scheduler/);
  assert.match(service, /After=.*boonetools-thornode-core-snapshot\.service/);
  assert.match(backfillService, /pool-dislocation-backfill/);
  assert.match(backfillService, /TimeoutStartSec=2h/);
  assert.match(repairService, /pool-dislocation-repair/);
  assert.match(repairService, /TimeoutStartSec=10m/);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:0\/5:00 UTC/);
  assert.match(repairTimer, /OnCalendar=\*-\*-\* \*:2\/15:00 UTC/);
  assert.match(deploy, /prime_read_models[\s\S]*boonetools-pool-dislocation-repair\.service/);
  assert.match(deploy, /prime_read_models[\s\S]*boonetools-pool-dislocation\.service/);
});
