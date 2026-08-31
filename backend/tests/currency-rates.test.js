import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENCY_RATES_TTL_MS,
  createCurrencyRatesService
} from '../src/shared/currency-rates.js';

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
