import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

import { currentCurrency, initCurrency, setCurrency } from '../src/lib/stores/currency.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

// A browser visit: the page URL plus whatever the browser kept in storage.
function visit(href, storage) {
  const url = new URL(href);
  globalThis.window = {
    location: { href: url.href, search: url.search },
    history: {
      pushState: (_state, _title, next) => {
        const updated = new URL(String(next));
        window.location.href = updated.href;
        window.location.search = updated.search;
      }
    },
    localStorage: storage
  };
}

test.beforeEach(() => {
  // Rates are irrelevant here; keep the store offline.
  globalThis.fetch = async () => { throw new Error('offline'); };
});

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.fetch;
});

test('a selected currency is restored on the next visit without a currency URL', async () => {
  const storage = memoryStorage();
  visit('https://boone.tools/thorfolio', storage);
  await initCurrency();
  setCurrency('EUR');

  visit('https://boone.tools/thorfolio?addresses=thor1example', storage);
  await initCurrency();
  assert.equal(get(currentCurrency), 'EUR');
});

test('a shared currency URL wins for that visit without replacing the saved choice', async () => {
  const storage = memoryStorage();
  visit('https://boone.tools/thorfolio', storage);
  setCurrency('GBP');

  visit('https://boone.tools/thorfolio?currency=btc', storage);
  await initCurrency();
  assert.equal(get(currentCurrency), 'BTC');

  visit('https://boone.tools/thorfolio', storage);
  await initCurrency();
  assert.equal(get(currentCurrency), 'GBP');
});

test('choosing USD again is remembered over an older saved currency', async () => {
  const storage = memoryStorage();
  visit('https://boone.tools/thorfolio', storage);
  setCurrency('JPY');
  setCurrency('USD');

  visit('https://boone.tools/thorfolio', storage);
  await initCurrency();
  assert.equal(get(currentCurrency), 'USD');
});

test('blocked or corrupt storage falls back to USD', async () => {
  const blocked = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); }
  };
  visit('https://boone.tools/thorfolio', blocked);
  assert.doesNotThrow(() => setCurrency('EUR'));
  visit('https://boone.tools/thorfolio', blocked);
  await initCurrency();
  assert.equal(get(currentCurrency), 'USD');

  const corrupt = memoryStorage();
  corrupt.setItem('boonetools_currency', 'DOGE');
  visit('https://boone.tools/thorfolio', corrupt);
  await initCurrency();
  assert.equal(get(currentCurrency), 'USD');
});
