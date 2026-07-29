import test from 'node:test';
import assert from 'node:assert/strict';

import { runPoolDislocationBackfill } from '../src/jobs/pool-dislocation-backfill.js';
import {
  buildHistoricalPoolDislocationRows,
  buildPoolDislocationBackfillBuckets,
  loadPoolDislocationBackfillPlan,
  normalizeBinanceKlineCloses,
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
