import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateBondHistoryRow,
  hasBondHistoryValue,
  isPoisonedBondHistoryRow,
  isTransientHistoricalFetchError
} from '../src/shared/bond-history.js';

test('calculateBondHistoryRow includes earned rewards and operator fee adjustment', () => {
  const row = calculateBondHistoryRow({
    bondAddress: 'thor1bond',
    nodePayloads: [
      {
        current_award: '100000000',
        bond_providers: {
          node_operator_fee: '1000',
          providers: [
            { bond_address: 'thor1bond', bond: '400000000' },
            { bond_address: 'thor1other', bond: '600000000' }
          ]
        }
      }
    ],
    networkData: {
      rune_price_in_tor: '41152196'
    },
    churnHeight: 25573978,
    churnTimestamp: 1774980252
  });

  assert.deepEqual(row, {
    churn_height: 25573978,
    churn_timestamp: 1774980252,
    rune_stack: 436000000,
    user_bond: 400000000,
    rune_price: 0.41152196,
    rates_json: null
  });
  assert.equal(hasBondHistoryValue(row), true);
});

test('isPoisonedBondHistoryRow flags all-zero cached rows', () => {
  assert.equal(isPoisonedBondHistoryRow({
    rune_stack: 0,
    user_bond: 0,
    rune_price: 0
  }), true);

  assert.equal(isPoisonedBondHistoryRow({
    rune_stack: 0,
    user_bond: 0,
    rune_price: 0.4
  }), true);

  assert.equal(isPoisonedBondHistoryRow({
    rune_stack: 100,
    user_bond: 90,
    rune_price: 0.4
  }), false);
});

test('isTransientHistoricalFetchError treats rate limits and transport failures as retryable', () => {
  assert.equal(isTransientHistoricalFetchError(new Error('Request failed (429) for /thorchain/network')), true);
  assert.equal(isTransientHistoricalFetchError(new Error('Challenge response for /thorchain/network')), true);
  assert.equal(isTransientHistoricalFetchError(new Error('fetch failed')), true);
  assert.equal(isTransientHistoricalFetchError(new Error('Request failed (404) for /thorchain/node')), false);
});
