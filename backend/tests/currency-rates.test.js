import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENCY_RATES_TTL_MS,
  createCurrencyRatesService,
  fetchCachedCurrencyRates
} from '../src/shared/currency-rates.js';
import { acquisitionDatabase } from './fixtures/acquisition-db.js';

test('currency rates are shared across visitors for ten minutes', async () => {
  let nowMs = Date.parse('2026-08-31T20:00:00Z');
  let providerCalls = 0;
  const service = createCurrencyRatesService({
    now: () => nowMs,
    fetchRates: async () => {
      providerCalls += 1;
      return { USD: 0.48, EUR: 0.41, BTC: 0.0000043 };
    }
  });

  const firstVisitor = await service.getRates();
  nowMs += CURRENCY_RATES_TTL_MS - 1;
  const laterVisitor = await service.getRates();

  assert.equal(CURRENCY_RATES_TTL_MS, 10 * 60 * 1000);
  assert.equal(providerCalls, 1);
  assert.deepEqual(laterVisitor.rates, firstVisitor.rates);
  assert.equal(firstVisitor.cacheStatus, 'miss');
  assert.equal(laterVisitor.cacheStatus, 'hit');

  nowMs += 1;
  const expiredVisitor = await service.getRates();
  assert.equal(providerCalls, 2);
  assert.equal(expiredVisitor.cacheStatus, 'miss');
});

test('concurrent visitors share one in-flight currency-rate request', async () => {
  let releaseProvider;
  let providerCalls = 0;
  const providerResult = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const service = createCurrencyRatesService({
    fetchRates: async () => {
      providerCalls += 1;
      return providerResult;
    }
  });

  const firstVisitor = service.getRates();
  const secondVisitor = service.getRates();
  releaseProvider({ USD: 0.48 });

  const [first, second] = await Promise.all([firstVisitor, secondVisitor]);
  assert.equal(providerCalls, 1);
  assert.deepEqual(first.rates, { USD: 0.48 });
  assert.deepEqual(second.rates, { USD: 0.48 });
});

test('provider failures are cached so visitor traffic cannot create a retry storm', async () => {
  let nowMs = Date.parse('2026-08-31T20:00:00Z');
  let providerCalls = 0;
  const service = createCurrencyRatesService({
    now: () => nowMs,
    fetchRates: async () => {
      providerCalls += 1;
      throw new Error('CoinGecko blocked this IP');
    }
  });

  const firstVisitor = await service.getRates();
  nowMs += CURRENCY_RATES_TTL_MS - 1;
  const laterVisitor = await service.getRates();

  assert.equal(providerCalls, 1);
  assert.deepEqual(firstVisitor.rates, { USD: 1 });
  assert.equal(firstVisitor.stale, true);
  assert.equal(laterVisitor.cacheStatus, 'stale');

  nowMs += 1;
  await service.getRates();
  assert.equal(providerCalls, 2);
});

test('short-lived jobs share one durable CoinGecko snapshot per ten-minute window', async () => {
  const client = acquisitionDatabase();
  let providerCalls = 0;
  const options = { client, nowMs: Date.parse('2026-10-30T02:00:00Z'),
    fetchRates: async () => { providerCalls += 1; return { USD: 1.2, EUR: 1.1, XMR: 0.004 }; } };
  const [first, second] = await Promise.all([fetchCachedCurrencyRates(options), fetchCachedCurrencyRates(options)]);
  assert.deepEqual(first, second);
  // A later process reads the saved row instead of calling the provider again.
  await fetchCachedCurrencyRates({ ...options, nowMs: options.nowMs + CURRENCY_RATES_TTL_MS - 1 });
  assert.equal(providerCalls, 1);
  await fetchCachedCurrencyRates({ ...options, nowMs: options.nowMs + CURRENCY_RATES_TTL_MS + 1 });
  assert.equal(providerCalls, 2);
  await assert.rejects(fetchCachedCurrencyRates({ ...options, client: acquisitionDatabase(),
    fetchRates: async () => ({ EUR: 1 }) }), /Invalid acquisition response/);
});
