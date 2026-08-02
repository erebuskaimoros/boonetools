import test from 'node:test';
import assert from 'node:assert/strict';

import { runPoolDislocationBackfill } from '../src/jobs/pool-dislocation-backfill.js';
import { runPoolDislocationRepair } from '../src/jobs/pool-dislocation-repair.js';
import {
  buildHistoricalPoolDislocationRows,
  buildPoolDislocationBackfillBuckets,
  fetchHistoricalPoolDislocationState,
  isTransientPoolDislocationBackfillError,
  loadPoolDislocationBackfillPlan,
  loadPoolDislocationRecentGapRepairPlan,
  normalizeBinanceKlineCloses,
  retryPoolDislocationBackfillOperation,
  resolvePoolDislocationBlockAnchors
} from '../src/shared/pool-dislocation-backfill.js';
import { upsertPoolDislocationRows } from '../src/shared/pool-dislocation-store.js';

test('backfill buckets are exact five-minute UTC points with an exclusive end', () => {
  assert.deepEqual(buildPoolDislocationBackfillBuckets(
    '2026-07-22T12:00:00Z',
    '2026-07-22T12:15:00Z'
  ), [
    '2026-07-22T12:00:00.000Z',
    '2026-07-22T12:05:00.000Z',
    '2026-07-22T12:10:00.000Z'
  ]);
  assert.throws(
    () => buildPoolDislocationBackfillBuckets('2026-07-22T12:01:00Z', '2026-07-22T12:15:00Z'),
    /exact five-minute/
  );
});

test('Binance five-minute closes map to the following exact boundary', () => {
  const closes = normalizeBinanceKlineCloses([
    [Date.parse('2026-07-22T12:00:00Z'), '99', '102', '98', '101', '1', Date.parse('2026-07-22T12:04:59.999Z')],
    [Date.parse('2026-07-22T12:05:00Z') * 1000, '101', '103', '100', '102', '1', Date.parse('2026-07-22T12:09:59.999Z') * 1000]
  ]);
  assert.equal(closes.get('2026-07-22T12:05:00.000Z'), 101);
  assert.equal(closes.get('2026-07-22T12:10:00.000Z'), 102);
});

test('historical state retries honor transient failures and provider cooldowns', async () => {
  let calls = 0;
  let now = 1_000;
  const delays = [];
  const retries = [];
  const result = await retryPoolDislocationBackfillOperation(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) {
      const error = new Error('provider is cooling down');
      error.name = 'ProviderCooldownError';
      error.blockedUntil = new Date(4_000).toISOString();
      throw error;
    }
    return { ok: true };
  }, {
    attempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 5_000,
    now: () => now,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
    onRetry: (event) => retries.push(event)
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 3_240]);
  assert.deepEqual(retries.map(({ nextAttempt }) => nextAttempt), [2, 3]);
});

test('historical state retry rejects non-transient provider responses', async () => {
  const error = new Error('bad request');
  error.status = 400;
  assert.equal(isTransientPoolDislocationBackfillError(error), false);
  await assert.rejects(
    retryPoolDislocationBackfillOperation(async () => { throw error; }, {
      attempts: 8,
      baseDelayMs: 0,
      maxDelayMs: 0
    }),
    /bad request/
  );
});

test('height interpolation resolves the latest finalized block at or before each point', async () => {
  const genesisMs = Date.parse('2026-07-22T12:00:00Z');
  let requests = 0;
  const anchors = await resolvePoolDislocationBlockAnchors([
    '2026-07-22T12:05:00Z',
    '2026-07-22T12:10:03Z'
  ], {
    requestDelayMs: 0,
    fetchStatus: async () => ({
      result: { sync_info: {
        earliest_block_height: '100',
        earliest_block_time: new Date(genesisMs).toISOString(),
        latest_block_height: '300',
        latest_block_time: new Date(genesisMs + 200 * 6000).toISOString()
      } }
    }),
    fetchBlock: async (height) => {
      requests += 1;
      return {
        result: { block: { header: {
          height: String(height),
          time: new Date(genesisMs + (height - 100) * 6000).toISOString()
        } } }
      };
    }
  });
  assert.deepEqual(anchors.map(({ height }) => height), [150, 200]);
  assert.ok(requests <= 6);
});

test('historical rows retain same-height THORChain and labelled Binance close provenance', () => {
  const rows = buildHistoricalPoolDislocationRows({
    observedAt: '2026-07-22T12:05:00.000Z',
    height: 123,
    blockTime: '2026-07-22T12:04:57.000Z'
  }, {
    pools: [{
      asset: 'BTC.BTC',
      status: 'Available',
      asset_tor_price: '10100000000',
      balance_asset: '100',
      balance_rune: '200'
    }],
    oracle: { prices: [{ symbol: 'BTC', price: '100' }] }
  }, new Map([['BTCUSDT', new Map([['2026-07-22T12:05:00.000Z', 100.5]])]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sampleOrigin, 'historical_backfill');
  assert.equal(rows[0].thorchainHeight, 123);
  assert.equal(rows[0].poolPriceUsd, 101);
  assert.equal(rows[0].oraclePriceUsd, 100);
  assert.equal(rows[0].binancePriceUsd, 100.5);
  assert.equal(rows[0].binanceBidUsd, null);
  assert.equal(rows[0].binanceAskUsd, null);
  assert.equal(rows[0].binancePriceMethod, 'kline-close');
});

test('historical rows label confirmed reference absence for idempotent repair', () => {
  const rows = buildHistoricalPoolDislocationRows({
    observedAt: '2026-07-22T12:05:00.000Z',
    height: 123,
    blockTime: '2026-07-22T12:04:57.000Z'
  }, {
    pools: [{
      asset: 'BTC.BTC',
      status: 'Available',
      asset_tor_price: '10100000000'
    }],
    oracle: { prices: [] }
  });
  assert.equal(rows[0].oraclePriceUsd, null);
  assert.equal(rows[0].oraclePriceMethod, 'thornode-oracle-unavailable');
  assert.equal(rows[0].binancePriceUsd, null);
  assert.equal(rows[0].binancePriceMethod, 'kline-close-unavailable');
});

test('historical rows distinguish an available but unaligned Binance close', () => {
  const observedAt = '2026-07-22T12:05:00.000Z';
  const rows = buildHistoricalPoolDislocationRows({
    observedAt,
    height: 123,
    blockTime: '2026-07-22T12:03:00.000Z'
  }, {
    pools: [{
      asset: 'BTC.BTC',
      status: 'Available',
      asset_tor_price: '10100000000'
    }],
    oracle: { prices: [{ symbol: 'BTC', price: '100' }] }
  }, new Map([['BTCUSDT', new Map([[observedAt, 100.5]])]]));
  assert.equal(rows[0].binancePriceUsd, null);
  assert.equal(rows[0].binancePriceMethod, 'kline-close-unaligned');
  assert.equal(rows[0].sourceSkewMs, 119_999);
});

test('an empty historical oracle remains an explicit source gap', async () => {
  const responses = [[{
    asset: 'BTC.BTC',
    status: 'Available',
    asset_tor_price: '10100000000'
  }], { prices: [] }];
  const state = await fetchHistoricalPoolDislocationState(123, {
    fetchHistorical: async () => responses.shift()
  });
  const rows = buildHistoricalPoolDislocationRows({
    observedAt: '2026-07-22T12:05:00.000Z',
    height: 123,
    blockTime: '2026-07-22T12:04:57.000Z'
  }, state, new Map([['BTCUSDT', new Map([['2026-07-22T12:05:00.000Z', 100.5]])]]));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].poolPriceUsd, 101);
  assert.equal(rows[0].oraclePriceUsd, null);
  assert.equal(rows[0].binancePriceUsd, 100.5);
  assert.equal(rows[0].oraclePriceMethod, 'thornode-oracle-unavailable');
});

test('backfill planning resumes missing buckets without touching scheduled history', async () => {
  let call = 0;
  const client = {
    query: async () => {
      call += 1;
      if (call === 1) {
        return { rows: [{
          scheduled_start: '2026-07-29T12:00:00Z',
          scheduled_end: '2026-07-29T12:10:00Z'
        }] };
      }
      return { rows: [{ observed_at: '2026-07-22T12:15:00Z' }] };
    }
  };
  const plan = await loadPoolDislocationBackfillPlan(client, {
    startAt: '2026-07-22T12:10:00Z',
    endAt: '2026-07-22T12:25:00Z'
  });
  assert.equal(plan.allBuckets.length, 3);
  assert.deepEqual(plan.pendingBuckets, [
    '2026-07-22T12:10:00.000Z',
    '2026-07-22T12:20:00.000Z'
  ]);
});

test('recent repair planning floors bounds and replaces degraded or missing buckets', async () => {
  let params;
  let sql = '';
  const client = {
    query: async (statement, values) => {
      sql = statement;
      params = values;
      return { rows: [
        { observed_at: '2026-07-29T12:00:00Z', authoritative: true },
        { observed_at: '2026-07-29T12:05:00Z', authoritative: false }
      ] };
    }
  };
  const plan = await loadPoolDislocationRecentGapRepairPlan(client, {
    startAt: '2026-07-29T12:00:48Z',
    endAt: '2026-07-29T12:17:42Z',
    maxBuckets: 2
  });
  assert.deepEqual(params.slice(0, 2), [
    '2026-07-29T12:00:00.000Z',
    '2026-07-29T12:15:00.000Z'
  ]);
  const expectedReferences = JSON.parse(params[2]);
  assert.deepEqual(
    expectedReferences.find(({ asset }) => asset.startsWith('ETH.WBTC-')),
    {
      asset: 'ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599',
      oracle_symbol: 'BTC',
      binance_symbol: 'WBTCUSDT'
    }
  );
  assert.deepEqual(plan.pendingBuckets, [
    '2026-07-29T12:05:00.000Z',
    '2026-07-29T12:10:00.000Z'
  ]);
  assert.equal(plan.existingBuckets, 1);
  assert.equal(plan.discoveredPendingBuckets, 2);
  assert.equal(plan.deferredBuckets, 0);
  assert.match(sql, /oracle_symbol is not distinct from expected\.oracle_symbol/);
  assert.match(sql, /binance_symbol is not distinct from expected\.binance_symbol/);
  assert.match(sql, /expected\.binance_symbol is null[\s\S]*observation\.binance_price_usd is null/);
  assert.match(sql, /bool_and\(\s*coalesce\([\s\S]*false\s*\)\s*\)[\s\S]*thorchain_market_snapshots[\s\S]*as authoritative/);
  assert.match(sql, /thornode-oracle-unavailable/);
  assert.match(sql, /thornode-oracle-unaligned/);
  assert.match(sql, /kline-close-unavailable/);
  assert.match(sql, /kline-close-unaligned/);
});

test('bulk upsert gives scheduled observations precedence over historical rows', async () => {
  let sql = '';
  let payload;
  const client = {
    query: async (statement, values) => {
      sql = statement;
      payload = JSON.parse(values[0]);
      return { rowCount: 1 };
    }
  };
  await upsertPoolDislocationRows(client, [{
    observedAt: '2026-07-22T12:00:00Z',
    asset: 'BTC.BTC',
    symbol: 'BTC',
    chain: 'BTC',
    poolStatus: 'Available',
    poolPriceUsd: 100,
    sampleOrigin: 'historical_backfill',
    thorchainHeight: 123,
    binancePriceUsd: 99,
    binancePriceMethod: 'kline-close'
  }]);
  assert.match(sql, /current\.sample_origin <> 'scheduled'/);
  assert.match(sql, /excluded\.sample_origin = 'scheduled'/);
  assert.match(sql, /current\.pool_price_method = 'thornode-core-snapshot'/);
  assert.match(sql, /current\.oracle_price_usd is null/);
  assert.match(sql, /current\.binance_price_usd is null/);
  assert.match(sql, /excluded\.sample_origin = 'historical_backfill'/);
  assert.equal(payload[0].sample_origin, 'historical_backfill');
  assert.equal(payload[0].binance_price_method, 'kline-close');
});

test('backfill runner owns an isolated lock and refreshes the live read model', async () => {
  let lockKey = '';
  let refreshed = 0;
  const result = await runPoolDislocationBackfill({
    lockRunner: async (key, callback) => {
      lockKey = key;
      return callback({ name: 'client' });
    },
    backfill: async () => ({ bucketsWritten: 2, observationsWritten: 80 }),
    refresh: async () => {
      refreshed += 1;
      return { ok: true };
    }
  });
  assert.equal(lockKey, 'boonetools:pool-dislocation-backfill');
  assert.equal(refreshed, 1);
  assert.equal(result.ok, true);
  assert.equal(result.bucketsWritten, 2);
});

test('repair runner shares the operator backfill lock and applies bounded defaults', async () => {
  let lockKey = '';
  let repairOptions;
  const result = await runPoolDislocationRepair({
    lockRunner: async (key, callback) => {
      lockKey = key;
      return callback({ name: 'client' });
    },
    maxBuckets: 3,
    repair: async (_client, options) => {
      repairOptions = options;
      return { bucketsWritten: 2, observationsWritten: 80 };
    }
  });
  assert.equal(lockKey, 'boonetools:pool-dislocation-backfill');
  assert.equal(repairOptions.loadPlan, loadPoolDislocationRecentGapRepairPlan);
  assert.equal(repairOptions.maxBuckets, 3);
  assert.equal(result.ok, true);
  assert.equal(result.bucketsWritten, 2);
});
