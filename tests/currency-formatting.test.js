import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  formatCurrency,
  formatCurrencyWithDecimals
} from '../src/lib/stores/currency.js';

test('USD values remain displayable when external currency rates are unavailable', () => {
  assert.equal(formatCurrency({}, 1234.56, 'USD'), '$1,235');
  assert.equal(formatCurrencyWithDecimals({}, 0.48080159, 'USD'), '$0.48');
});

test('current currency rates come from the shared BooneTools backend cache', () => {
  const source = readFileSync(
    new URL('../src/lib/stores/currency.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /booneToolsApi\.get\(['"]\/currency-rates['"]/);
  assert.doesNotMatch(source, /api\.coingecko\.com\/api\/v3\/simple\/price/);
});
