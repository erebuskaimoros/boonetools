import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchStockPrices } from '../src/shared/stock-prices.js';
import { acquisitionDatabase } from './fixtures/acquisition-db.js';

test('concurrent visitors share each Yahoo symbol and historical prices can be corrected after TTL', async () => {
  const client = acquisitionDatabase();
  const calls = [];
  const options = { client, nowMs: Date.parse('2026-09-02T12:00:00Z'), from: 100, to: 200,
    fetchQuote: async (symbol) => { calls.push(symbol); return [[123, calls.length]]; } };
  const [first, second] = await Promise.all([
    fetchStockPrices(['SPY', 'VT'], options), fetchStockPrices(['SPY'], options)
  ]);
  assert.equal(calls.filter((symbol) => symbol === 'SPY').length, 1);
  assert.deepEqual(first.prices.SPY, second.prices.SPY);
  await fetchStockPrices(['SPY'], options);
  assert.equal(calls.length, 2);
  await fetchStockPrices(['SPY'], { ...options, nowMs: options.nowMs + 3_600_001 });
  assert.equal(calls.length, 3);
});
