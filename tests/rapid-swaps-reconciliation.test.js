import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRapidSwapHintKey,
  normalizeRapidSwapHint,
  pickBestRapidSwapRowMatch,
  scoreRapidSwapRowMatch
} from '../src/lib/rapid-swaps/reconciliation.js';

test('buildRapidSwapHintKey prefers tx id when present', () => {
  assert.equal(
    buildRapidSwapHintKey({ tx_id: 'ABC123' }),
    'tx:abc123'
  );
});

test('buildRapidSwapHintKey falls back to hint fields when tx id is missing', () => {
  assert.equal(
    buildRapidSwapHintKey({
      source_address: 'thor1abc',
      memo: '=:ETH.ETH:thor1dest:0/0/4',
      observed_height: 100,
      last_height: 101,
      deposit: '123',
      in: '456',
      out: '789'
    }),
    'hint|thor1abc|=:ETH.ETH:thor1dest:0/0/4|100|101|123|456|789'
  );
});

test('normalizeRapidSwapHint fills defaults and computes the hint key', () => {
  const hint = normalizeRapidSwapHint({
    memo: '=:ETH.ETH:thor1dest:0/0/4'
  });

  assert.equal(hint.status, 'pending');
  assert.equal(hint.hint_key, 'hint||=:ETH.ETH:thor1dest:0/0/4|0|0|||');
});

test('pickBestRapidSwapRowMatch prefers memo and address match over weaker height-only matches', () => {
  const hint = {
    tx_id: '',
    memo: '=:ETH.ETH:thor1dest:0/0/4',
    source_address: 'thor1source',
    observed_height: 100,
    last_height: 101
  };

  const weaker = {
    tx_id: 'weak',
    memo: '=:BTC.BTC:thor1dest:0/0/4',
    source_address: 'thor1source',
    action_date: '2026-03-31T19:00:00.000Z',
    action_height: 100,
    raw_action: {
      metadata: {
        swap: {
          streamingSwapMeta: {
            lastHeight: '101'
          }
        }
      }
    }
  };

  const stronger = {
    tx_id: 'strong',
    memo: hint.memo,
    source_address: hint.source_address,
    action_date: '2026-03-31T19:00:05.000Z',
    action_height: 103,
    raw_action: {
      metadata: {
        swap: {
          streamingSwapMeta: {
            lastHeight: '101'
          }
        }
      }
    }
  };

  assert.equal(pickBestRapidSwapRowMatch([weaker, stronger], hint)?.tx_id, 'strong');
});

test('scoreRapidSwapRowMatch strongly prefers exact tx id matches', () => {
  const hint = {
    tx_id: 'ABC123',
    memo: '=:ETH.ETH:thor1dest:0/0/4',
    source_address: 'thor1source',
    observed_height: 100,
    last_height: 101
  };

  const exact = {
    tx_id: 'ABC123',
    memo: 'other',
    source_address: 'other',
    action_height: 200,
    raw_action: {}
  };

  const memoOnly = {
    tx_id: 'DIFFERENT',
    memo: hint.memo,
    source_address: hint.source_address,
    action_height: 100,
    raw_action: {
      metadata: {
        swap: {
          streamingSwapMeta: {
            lastHeight: '101'
          }
        }
      }
    }
  };

  assert.ok(scoreRapidSwapRowMatch(exact, hint) > scoreRapidSwapRowMatch(memoOnly, hint));
});
