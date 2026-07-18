import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketReserveEvents,
  fillBucketGaps,
  getTargetsForConfig,
  parseCsv,
  pickPaidRows,
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

  assert.deepEqual(pickPaidRows(events, weekly, 'daily', daily), {
    rows: daily.map((row) => ({ ...row, bucket_start: row.day_start })),
    grain: 'daily'
  });
  assert.deepEqual(pickPaidRows(events, weekly, 'weekly', daily), {
    rows: weekly.map((row) => ({ ...row, bucket_start: row.week_start })),
    grain: 'weekly'
  });
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
