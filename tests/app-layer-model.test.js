import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketReserveEvents,
  excludePolFromAccruals,
  fillBucketGaps,
  getTargetsForConfig,
  parseCsv,
  pickAccruedValueRows,
  pickPaidRows,
  summarizeAppLayerValue,
  summarizeCollectorInventory
} from '../src/lib/app-layer/model.js';

test('app-layer CSV and reserve event normalization remain deterministic', () => {
  const rows = parseCsv(
    'week_start,payments,payment_rune,cumulative_usd\n2026-01-05,2,3.5,10.25\n'
  );
  assert.deepEqual(rows, [{
    week_start: '2026-01-05',
    payments: 2,
    payment_rune: 3.5,
    cumulative_usd: 10.25
  }]);

  const buckets = bucketReserveEvents([
    { date: '2026-01-05T01:00:00Z', amountRune: 2, runePriceUsd: 3, amountUsd: 6 },
    { date: '2026-01-06T01:00:00Z', amountRune: 1, runePriceUsd: 4, amountUsd: 4 }
  ], 'weekly');
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].payment_rune, 3);
  assert.equal(buckets[0].payment_usd, 10);
  assert.equal(buckets[0].rune_price_usd, 10 / 3);
});

test('app-layer settlement buckets keep Reserve history and add post-cutover POL payments', () => {
  const buckets = bucketReserveEvents([
    {
      date: '2026-08-13T12:27:11Z',
      paymentType: 'reserve',
      amountRune: 4,
      runePriceUsd: 3,
      amountUsd: 12
    },
    {
      date: '2026-08-13T12:27:11Z',
      payment_type: 'pol',
      amountRune: 2,
      runePriceUsd: 3,
      amountUsd: 6
    }
  ], 'daily');

  assert.deepEqual(buckets, [{
    bucket_start: '2026-08-13',
    payments: 1,
    payment_rune: 4,
    payment_usd: 12,
    pol_payments: 1,
    pol_rune: 2,
    pol_usd: 6,
    settlement_events: 2,
    settlement_rune: 6,
    settlement_usd: 18,
    rune_price_usd: 3,
    cumulative_rune: 4,
    cumulative_usd: 12,
    cumulative_pol_rune: 2,
    cumulative_pol_usd: 6,
    cumulative_settlement_rune: 6,
    cumulative_settlement_usd: 18
  }]);
});

test('app-layer paid aggregates gracefully promote legacy Reserve-only rows to settlement totals', () => {
  const weekly = [{
    week_start: '2026-08-10',
    payments: 2,
    payment_rune: 9,
    payment_usd: 27,
    cumulative_rune: 20,
    cumulative_usd: 60
  }];

  const picked = pickPaidRows([], weekly, 'weekly');
  assert.deepEqual(picked.rows[0], {
    ...weekly[0],
    bucket_start: '2026-08-10',
    pol_payments: 0,
    pol_rune: 0,
    pol_usd: 0,
    settlement_events: 2,
    settlement_rune: 9,
    settlement_rune_price_usd: 0,
    settlement_usd: 27,
    cumulative_pol_rune: 0,
    cumulative_pol_usd: 0,
    cumulative_settlement_rune: 20,
    cumulative_settlement_usd: 60
  });
});

test('app-layer paid charts use durable full-history aggregates before bounded events', () => {
  const events = [
    { date: '2026-07-18T01:00:00Z', amountRune: 1, runePriceUsd: 2, amountUsd: 2 }
  ];
  const daily = [
    { day_start: '2026-01-01', payment_usd: 5, cumulative_usd: 5 },
    { day_start: '2026-07-18', payment_usd: 2, cumulative_usd: 7 }
  ];
  const weekly = [
    { week_start: '2025-12-29', payment_usd: 5, cumulative_usd: 5 },
    { week_start: '2026-07-13', payment_usd: 2, cumulative_usd: 7 }
  ];

  const dailyPick = pickPaidRows(events, weekly, 'daily', daily);
  assert.equal(dailyPick.grain, 'daily');
  assert.deepEqual(dailyPick.rows.map((row) => ({
    bucket_start: row.bucket_start,
    payment_usd: row.payment_usd,
    settlement_usd: row.settlement_usd,
    cumulative_settlement_usd: row.cumulative_settlement_usd
  })), [
    { bucket_start: '2026-01-01', payment_usd: 5, settlement_usd: 5, cumulative_settlement_usd: 5 },
    { bucket_start: '2026-07-18', payment_usd: 2, settlement_usd: 2, cumulative_settlement_usd: 7 }
  ]);

  const weeklyPick = pickPaidRows(events, weekly, 'weekly', daily);
  assert.equal(weeklyPick.grain, 'weekly');
  assert.deepEqual(weeklyPick.rows.map((row) => ({
    bucket_start: row.bucket_start,
    payment_usd: row.payment_usd,
    settlement_usd: row.settlement_usd,
    cumulative_settlement_usd: row.cumulative_settlement_usd
  })), [
    { bucket_start: '2025-12-29', payment_usd: 5, settlement_usd: 5, cumulative_settlement_usd: 5 },
    { bucket_start: '2026-07-13', payment_usd: 2, settlement_usd: 2, cumulative_settlement_usd: 7 }
  ]);
});

test('app-layer chart model keeps scheduler gaps visible', () => {
  const rows = fillBucketGaps([
    { bucket_start: '2026-01-01', payment_usd: 5, cumulative_usd: 5 },
    { bucket_start: '2026-01-03', payment_usd: 2, cumulative_usd: 7 }
  ], 'payment_usd', 'cumulative_usd', 1);

  assert.deepEqual(rows, [
    { bucket_start: '2026-01-01', payment_usd: 5, cumulative_usd: 5 },
    { bucket_start: '2026-01-02', payment_usd: 0, cumulative_usd: 5 },
    { bucket_start: '2026-01-03', payment_usd: 2, cumulative_usd: 7 }
  ]);
});

test('accrued TC value aligns 01 and 03 without double-counting 02', () => {
  const inflows = {
    daily: [
      { day_start: '2026-04-30', inflow_usd: 10, cumulative_usd: 110 },
      { day_start: '2026-05-02', inflow_usd: 5, cumulative_usd: 115 }
    ]
  };
  const generatedFees = {
    daily: [
      { day_start: '2026-04-29', liquidity_fee_usd: 1, cumulative_usd: 1 },
      { day_start: '2026-04-30', liquidity_fee_usd: 2, cumulative_usd: 3 },
      { day_start: '2026-05-01', liquidity_fee_usd: 3, cumulative_usd: 6 },
      { day_start: '2026-05-02', liquidity_fee_usd: 4, cumulative_usd: 10 }
    ]
  };

  assert.deepEqual(pickAccruedValueRows(inflows, generatedFees, 'daily'), {
    grain: 'daily',
    rows: [
      {
        bucket_start: '2026-04-29',
        accrued_value_usd: 1,
        cumulative_usd: 1,
        inflow_usd: 0,
        liquidity_fee_usd: 1
      },
      {
        bucket_start: '2026-04-30',
        accrued_value_usd: 12,
        cumulative_usd: 113,
        inflow_usd: 10,
        liquidity_fee_usd: 2
      },
      {
        bucket_start: '2026-05-01',
        accrued_value_usd: 3,
        cumulative_usd: 116,
        inflow_usd: 0,
        liquidity_fee_usd: 3
      },
      {
        bucket_start: '2026-05-02',
        accrued_value_usd: 9,
        cumulative_usd: 125,
        inflow_usd: 5,
        liquidity_fee_usd: 4
      }
    ]
  });
});

test('the first two chart lanes exclude value settled to POL', () => {
  const adjusted = excludePolFromAccruals({
    meta: {
      totalInflowUsd: 125,
      netNewInflowUsd: 75
    },
    daily: [
      { day_start: '2026-08-12', inflow_usd: 30, cumulative_usd: 100 },
      { day_start: '2026-08-13', inflow_usd: 15, cumulative_usd: 115 },
      { day_start: '2026-08-14', inflow_usd: 10, cumulative_usd: 125 },
      { day_start: '2026-08-15', inflow_usd: 0, cumulative_usd: 125 }
    ],
    weekly: [
      { week_start: '2026-08-10', inflow_usd: 55, cumulative_usd: 125 },
      { week_start: '2026-08-17', inflow_usd: 0, cumulative_usd: 125 }
    ]
  }, {
    meta: { totalPolUsd: 8 },
    daily: [
      { day_start: '2026-08-13', pol_usd: 5, cumulative_pol_usd: 5 },
      { day_start: '2026-08-14', pol_usd: 3, cumulative_pol_usd: 8 }
    ],
    weekly: [
      { week_start: '2026-08-10', pol_usd: 8, cumulative_pol_usd: 8 }
    ]
  });

  assert.deepEqual(adjusted.daily, [
    {
      day_start: '2026-08-12',
      inflow_usd: 30,
      cumulative_usd: 100,
      gross_inflow_usd: 30,
      pol_usd_excluded: 0
    },
    {
      day_start: '2026-08-13',
      inflow_usd: 10,
      cumulative_usd: 110,
      gross_inflow_usd: 15,
      pol_usd_excluded: 5
    },
    {
      day_start: '2026-08-14',
      inflow_usd: 7,
      cumulative_usd: 117,
      gross_inflow_usd: 10,
      pol_usd_excluded: 3
    },
    {
      day_start: '2026-08-15',
      inflow_usd: 0,
      cumulative_usd: 117,
      gross_inflow_usd: 0,
      pol_usd_excluded: 0
    }
  ]);
  assert.deepEqual(adjusted.weekly, [
    {
      week_start: '2026-08-10',
      inflow_usd: 47,
      cumulative_usd: 117,
      gross_inflow_usd: 55,
      pol_usd_excluded: 8
    },
    {
      week_start: '2026-08-17',
      inflow_usd: 0,
      cumulative_usd: 117,
      gross_inflow_usd: 0,
      pol_usd_excluded: 0
    }
  ]);
  assert.equal(adjusted.meta.totalInflowUsd, 117);
  assert.equal(adjusted.meta.netNewInflowUsd, 67);
});

test('top-level value separates POL capital from realized value to THORChain', () => {
  assert.deepEqual(summarizeAppLayerValue({
    reserveUsd: 60,
    polUsd: 30,
    liquidityFeeUsd: 10
  }), {
    reserveUsd: 60,
    polAllocatedUsd: 30,
    liquidityFeeUsd: 10,
    realizedTcUsd: 70,
    totalTrackedUsd: 100,
    reserveShare: 60 / 70 * 100,
    liquidityFeeShare: 10 / 70 * 100
  });
});

test('app-layer inventory classification uses one pricing and route model', () => {
  const inventory = summarizeCollectorInventory(
    { target_denoms: [['rune', '0']] },
    [
      { denom: 'rune', amount: '200000000' },
      { denom: 'x/usdc', amount: '300000000' },
      { denom: 'x/unknown', amount: '100000000' }
    ],
    [{ denom: 'x/usdc' }],
    { runePriceUsd: 4, poolPrices: {} }
  );

  assert.equal(inventory.eligible.count, 1);
  assert.equal(inventory.eligible.pricedUsd, 8);
  assert.equal(inventory.conversion.count, 1);
  assert.equal(inventory.conversion.pricedUsd, 3);
  assert.equal(inventory.blocked.count, 1);
});

test('app-layer target resolution preserves live weights and fallback metadata', () => {
  const options = {
    staticTargets: { base: [{ address: 'reserve', label: 'Reserve', percent: 100 }] },
    addressLabels: { a: 'A', b: 'B' }
  };
  assert.equal(getTargetsForConfig('base', null, options)[0].isFallback, true);
  assert.deepEqual(getTargetsForConfig('base', {
    target_addresses: [['a', '1'], ['b', '3']]
  }, options), [
    { address: 'a', label: 'A', percent: 25, isFallback: false },
    { address: 'b', label: 'B', percent: 75, isFallback: false }
  ]);
});
