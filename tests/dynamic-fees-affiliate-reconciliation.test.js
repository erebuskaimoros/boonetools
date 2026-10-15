import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAffiliateMidgardSeries, buildAffiliateTransactionView, buildAffiliateTrendView } from '../src/lib/dynamic-fees/model.js';

const startTime = '1791763200'; // 2026-10-12 UTC
const endTime = '1791849600';
const historicalPrice = 0.6544795427941561;
const capturedRows = [
  [119222.01957861651, 62.39575756],
  [73527.35309813224, 37.99157374],
  [49870.20839902704, 33.5129701],
  [31314.476209577468, 17.80582196],
  [3974.852024705648, 5.12561808],
  [70.06956854762811, 0.15590308],
  [40.64175287186838, 0.05968973],
  [38.71544040910273, 0.01648189],
  [20.118555808810672, 0.00581526]
];
const volumeUsd = capturedRows.reduce((sum, row) => sum + row[0], 0);
const volume = [{ startTime, endTime, legVolumeUsd: volumeUsd, routeCount: 9, executedLegCount: 17 }];
const prices = [{ startTime, endTime, runePriceUSD: String(historicalPrice) }];
const earnings = {
  startTime, endTime, count: '9', totalEarningsUSD: '10191', totalEarningsRune: '15706963140',
  affiliates: [
    { affiliate: 'ns/ss', count: '4', earningsUSD: '9843', earningsRUNE: '15170612336' },
    { affiliate: 'ss', count: '5', earningsUSD: '348', earningsRUNE: '536350804' }
  ]
};
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`);

test('October 12 SS chart reconciles all nine swaps including the four ns/ss routes', () => {
  const before = structuredClone(earnings);
  const series = buildAffiliateMidgardSeries(volume, [earnings], 'SS', prices);
  const point = series.points[0];
  assert.equal(point.feesUsd, 101.91);
  close(point.feesRune, 157.0696314, 'RUNE fees');
  assert.equal(point.count, 9);
  close(point.volumeUsd, volumeUsd, 'volume unchanged');
  close(point.rateFeesUsd, 157.0696314 * historicalPrice, 'historical rate numerator');
  close(point.rateBps, point.rateFeesUsd / volumeUsd * 10000, 'fee rate');

  const transactions = capturedRows.map(([volumeUsd, liquidityFeeRune], index) => ({
    txId: `captured-${index}`, dateMs: (Number(startTime) + index + 1) * 1000, volumeUsd, liquidityFeeRune
  }));
  const table = buildAffiliateTransactionView(transactions, series.points);
  close(table.totalFeesUsd, series.totalFeesUsd, 'chart/table displayed fees');
  close(table.totalRateFeesUsd, series.totalRateFeesUsd, 'chart/table historical fees');
  close(table.totalRateBps, series.totalRateBps, 'chart/table rates');
  for (const bucket of ['day', 'week', 'month']) {
    const view = buildAffiliateTrendView(series, 1, [], bucket);
    close(view.totalFeesUsd, 101.91, `${bucket} summary fees`);
    close(view.points[0].feesUsd, 101.91, `${bucket} bucket fees`);
    close(view.points[0].rateBps, point.rateBps, `${bucket} bucket rate`);
  }
  assert.deepEqual(earnings, before, 'aggregation must not mutate cached source rows');
});

test('affiliate matching uses complete case-insensitive slash-delimited names, once per route group', () => {
  const row = { startTime, endTime, totalEarningsUSD: '99999', totalEarningsRune: '99999000000', count: '999', affiliates: [
    { affiliate: 'ss', earningsUSD: '100', earningsRUNE: '100000000', count: '1' },
    { affiliate: 'NS/SS', earningsUSD: '200', earningsRUNE: '200000000', count: '2' },
    { affiliate: 'ss/ns', earningsUSD: '300', earningsRUNE: '300000000', count: '3' },
    { affiliate: 'ns/ss/ss', earningsUSD: '400', earningsRUNE: '400000000', count: '4' },
    { affiliate: 'nss', earningsUSD: '500', earningsRUNE: '500000000', count: '5' },
    { affiliate: 'ns/ss2', earningsUSD: '600', earningsRUNE: '600000000', count: '6' }
  ] };
  const point = buildAffiliateMidgardSeries([], [row], 'sS', prices).points[0];
  assert.equal(point.feesUsd, 10);
  assert.equal(point.feesRune, 10);
  assert.equal(point.count, 10);
});

test('unrelated affiliate groups do not fall back to whole-response totals', () => {
  const row = { ...earnings, affiliates: [{ affiliate: 'ns/ss2', earningsUSD: '999', earningsRUNE: '999000000', count: '99' }] };
  const point = buildAffiliateMidgardSeries([], [row], 'ss', prices).points[0];
  assert.equal(point.feesUsd, 0);
  assert.equal(point.feesRune, 0);
  assert.equal(point.count, 0);
});

test('aggregate-only historical responses preserve their scoped totals', () => {
  const { affiliates, ...row } = earnings;
  const point = buildAffiliateMidgardSeries([], [row], 'ss', prices).points[0];
  assert.equal(point.feesUsd, 101.91);
  close(point.feesRune, 157.0696314, 'aggregate-only RUNE');
  assert.equal(point.count, 9);
});

test('a missing RUNE amount in any matching group leaves historical fee rates unavailable', () => {
  for (const missing of [undefined, null, '']) {
    const row = structuredClone(earnings);
    row.affiliates[0].earningsRUNE = missing;
    const series = buildAffiliateMidgardSeries(volume, [row], 'ss', prices);
    const point = series.points[0];
    assert.equal(point.feesUsd, 101.91, 'display USD remains independently available');
    assert.equal(point.feesRuneAvailable, false);
    assert.equal(point.rateFeesUsd, null);
    assert.equal(point.rateBps, null);
    assert.equal(series.totalRateFeesUsd, null);
    assert.equal(series.totalRateBps, null);
  }
});

test('unrelated missing RUNE amounts do not invalidate selected affiliate coverage', () => {
  const row = structuredClone(earnings);
  row.affiliates.push({ affiliate: 'other', earningsUSD: '999', count: '99' });
  const point = buildAffiliateMidgardSeries(volume, [row], 'ss', prices).points[0];
  assert.equal(point.feesUsd, 101.91);
  assert.equal(point.feesRuneAvailable, true);
  close(point.feesRune, 157.0696314, 'selected RUNE fees');
  close(point.rateFeesUsd, 157.0696314 * historicalPrice, 'selected historical fees');
  assert.equal(point.count, 9);
});

test('aggregate-only responses with an empty group list retain their scoped totals', () => {
  const row = { ...earnings, affiliates: [] };
  const point = buildAffiliateMidgardSeries([], [row], 'ss', prices).points[0];
  assert.equal(point.feesUsd, 101.91);
  close(point.feesRune, 157.0696314, 'aggregate-only RUNE');
  assert.equal(point.count, 9);
});
