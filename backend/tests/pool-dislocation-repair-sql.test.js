import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { upsertPoolDislocationRows } from '../src/shared/pool-dislocation-store.js';
import { loadPoolDislocationRecentGapRepairPlan } from '../src/shared/pool-dislocation-backfill.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const observedAt = '2026-08-29T08:35:00.000Z';
const baseRow = { observedAt, asset: 'BTC.BTC', symbol: 'BTC', chain: 'BTC', poolStatus: 'Available',
  poolPriceUsd: 100, oracleSymbol: 'BTC', oraclePriceUsd: 100,
  binanceSymbol: 'BTCUSDT', binancePriceUsd: 100, binanceBidUsd: 100, binanceAskUsd: 100,
  sampleOrigin: 'scheduled', thorchainHeight: null, poolPriceMethod: 'thornode-asset-tor',
  oraclePriceMethod: 'thornode-oracle', binancePriceMethod: 'book-ticker-mid' };

async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('truncate pool_dislocation_observations, thorchain_market_snapshots');
    await run(client);
  } finally {
    await client.query('rollback');
    await client.end();
  }
}

const planOptions = { startAt: observedAt, endAt: '2026-08-29T08:40:00.000Z' };

async function insertSnapshot(client, height = 123) {
  await client.query(`insert into thorchain_market_snapshots
    (height, block_time, pools_json, oracle_prices_json, source)
    values ($1, '2026-08-29T08:34:59Z', '[]', '[]', 'test')`, [height]);
}

test('historical repair completes a scheduled bucket missing height instead of selecting it forever',
  { skip: !databaseUrl }, async () => withDatabase(async (client) => {
    await upsertPoolDislocationRows(client, [baseRow]);
    assert.deepEqual((await loadPoolDislocationRecentGapRepairPlan(client, planOptions)).pendingBuckets, [observedAt]);
    await insertSnapshot(client);
    const result = await upsertPoolDislocationRows(client, [{ ...baseRow, sampleOrigin: 'historical_backfill',
      thorchainHeight: 123, poolPriceUsd: 101, binancePriceMethod: 'kline-close' }]);
    assert.equal(result.rowCount, 1, 'repair must replace the incomplete scheduled observation');
    assert.deepEqual((await loadPoolDislocationRecentGapRepairPlan(client, planOptions)).pendingBuckets, [],
      'the next timer must not select the same completed bucket again');
    const saved = (await client.query('select * from pool_dislocation_observations')).rows[0];
    assert.equal(saved.sample_origin, 'historical_backfill');
    assert.equal(Number(saved.pool_price_usd), 101);
    assert.equal(saved.binance_price_method, 'kline-close');
  }));

test('historical repair replaces a scheduled height whose market snapshot is missing atomically',
  { skip: !databaseUrl }, async () => withDatabase(async (client) => {
    await upsertPoolDislocationRows(client, [{ ...baseRow, thorchainHeight: 122 }]);
    assert.deepEqual((await loadPoolDislocationRecentGapRepairPlan(client, planOptions)).pendingBuckets, [observedAt]);
    await insertSnapshot(client);
    const reconstructed = { ...baseRow, sampleOrigin: 'historical_backfill', thorchainHeight: 123,
      poolPriceUsd: 101, poolBalanceAsset: 12, poolBalanceRune: 34,
      oraclePriceUsd: 102, oracleObservedAt: '2026-08-29T08:34:59.000Z',
      binancePriceUsd: 103, binanceBidUsd: null, binanceAskUsd: null,
      binanceObservedAt: '2026-08-29T08:34:58.000Z', sourceSkewMs: 1000,
      poolPriceMethod: 'thornode-asset-tor', oraclePriceMethod: 'thornode-oracle',
      binancePriceMethod: 'kline-close' };
    assert.equal((await upsertPoolDislocationRows(client, [reconstructed])).rowCount, 1);
    assert.deepEqual((await loadPoolDislocationRecentGapRepairPlan(client, planOptions)).pendingBuckets, []);
    const saved = (await client.query('select * from pool_dislocation_observations')).rows[0];
    assert.equal(saved.sample_origin, reconstructed.sampleOrigin);
    assert.equal(Number(saved.thorchain_height), 123);
    assert.equal(Number(saved.pool_price_usd), 101);
    assert.equal(Number(saved.pool_balance_asset), 12);
    assert.equal(Number(saved.pool_balance_rune), 34);
    assert.equal(Number(saved.oracle_price_usd), 102);
    assert.equal(saved.oracle_observed_at.toISOString(), reconstructed.oracleObservedAt);
    assert.equal(Number(saved.binance_price_usd), 103);
    assert.equal(saved.binance_bid_usd, null);
    assert.equal(saved.binance_ask_usd, null);
    assert.equal(saved.binance_observed_at.toISOString(), reconstructed.binanceObservedAt);
    assert.equal(saved.source_skew_ms, 1000);
    assert.equal(saved.pool_price_method, reconstructed.poolPriceMethod);
    assert.equal(saved.oracle_price_method, reconstructed.oraclePriceMethod);
    assert.equal(saved.binance_price_method, reconstructed.binancePriceMethod);
  }));

test('a complete scheduled observation remains preferred over historical reconstruction',
  { skip: !databaseUrl }, async () => withDatabase(async (client) => {
    await insertSnapshot(client);
    await insertSnapshot(client, 124);
    await upsertPoolDislocationRows(client, [{ ...baseRow, thorchainHeight: 123 }]);
    const before = (await client.query('select * from pool_dislocation_observations')).rows;
    assert.equal((await upsertPoolDislocationRows(client, [{ ...baseRow,
      sampleOrigin: 'historical_backfill', thorchainHeight: 124, poolPriceUsd: 101,
      binancePriceMethod: 'kline-close' }])).rowCount, 0);
    assert.deepEqual((await client.query('select * from pool_dislocation_observations')).rows, before);
  }));

for (const incomingHeight of [null, 0, -1, 124]) {
  test(`repair cannot replace valid scheduled prices without a usable matching snapshot (height ${incomingHeight})`,
    { skip: !databaseUrl }, async () => withDatabase(async (client) => {
      // An unrelated snapshot must not satisfy the incoming observation's requirement.
      await insertSnapshot(client);
      await upsertPoolDislocationRows(client, [baseRow]);
      const before = (await client.query('select * from pool_dislocation_observations')).rows;
      assert.equal((await upsertPoolDislocationRows(client, [{ ...baseRow,
        sampleOrigin: 'historical_backfill', thorchainHeight: incomingHeight,
        poolPriceUsd: 101, binancePriceMethod: 'kline-close' }])).rowCount, 0);
      assert.deepEqual((await client.query('select * from pool_dislocation_observations')).rows, before);
      assert.deepEqual((await loadPoolDislocationRecentGapRepairPlan(client, planOptions)).pendingBuckets, [observedAt]);
    }));
}
