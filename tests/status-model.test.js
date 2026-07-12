import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChainStatuses,
  getGovernanceVotes,
  getRecentStatusUpdates,
  isHeightMimirActive,
  summarizeNetwork
} from '../src/lib/status/model.js';

test('height Mimirs activate only after a positive activation height', () => {
  assert.equal(isHeightMimirActive(1, 100), true);
  assert.equal(isHeightMimirActive(101, 100), false);
  assert.equal(isHeightMimirActive(0, 100), false);
});

test('chain status keeps trading and LP actions distinct', () => {
  const rows = buildChainStatuses([
    {
      chain: 'BTC',
      halted: false,
      global_trading_paused: false,
      chain_trading_paused: false,
      chain_lp_actions_paused: true
    },
    {
      chain: 'ETH',
      halted: true,
      global_trading_paused: false,
      chain_trading_paused: true,
      chain_lp_actions_paused: false
    }
  ], {
    'PAUSELPDEPOSIT-ETH-USDC-0X123': 1
  }, [
    { chain: 'BTC', last_observed_in: 900, last_signed_out: 95, thorchain: 100 }
  ]);

  assert.deepEqual(rows[0], {
    chain: 'BTC',
    trading: 'enabled',
    deposits: 'paused',
    withdrawals: 'paused',
    lastObservedIn: 900,
    lastSignedOut: 95,
    thorchainHeight: 100,
    degraded: true
  });
  assert.equal(rows[1].trading, 'paused');
  assert.equal(rows[1].deposits, 'partial');
  assert.equal(rows[1].withdrawals, 'enabled');
});

test('network summary is degraded when any chain action is unavailable', () => {
  const summary = summarizeNetwork([
    { chain: 'BTC', trading: 'enabled', deposits: 'enabled', withdrawals: 'enabled', degraded: false },
    { chain: 'SOL', trading: 'paused', deposits: 'paused', withdrawals: 'paused', degraded: true }
  ]);

  assert.equal(summary.label, 'Degraded');
  assert.equal(summary.tradingEnabled, 1);
  assert.deepEqual(summary.degradedChains, ['SOL']);
});

test('a full chain halt blocks LP deposits and withdrawals even without PauseLP', () => {
  const [row] = buildChainStatuses([{
    chain: 'GAIA',
    halted: true,
    global_trading_paused: false,
    chain_trading_paused: true,
    chain_lp_actions_paused: false
  }], {
    HALTGAIACHAIN: 1
  }, [{ chain: 'GAIA', thorchain: 100 }]);

  assert.equal(row.deposits, 'paused');
  assert.equal(row.withdrawals, 'paused');
});

test('status updates translate effective halt values into plain language', () => {
  const updates = getRecentStatusUpdates([
    {
      mimir_key: 'HALTBASETRADING',
      effective_history: [{ effective_value: '1', block_time: '2026-07-10T09:00:00Z', height: 20 }]
    },
    {
      mimir_key: 'HALTGAIATRADING',
      effective_history: [{ effective_value: '0', block_time: '2026-07-11T09:00:00Z', height: 30 }]
    }
  ]);

  assert.equal(updates[0].description, 'GAIA trading resumed');
  assert.equal(updates[0].tone, 'ok');
  assert.equal(updates[1].description, 'BASE trading halted');
});

test('status updates keep only the newest observation of the same effective state', () => {
  const updates = getRecentStatusUpdates([
    {
      mimir_key: 'HALTCHURNING',
      effective_history: [
        { effective_value: '1', block_time: '2026-07-10T09:00:00Z', height: 20 },
        { effective_value: '1', block_time: '2026-07-09T09:00:00Z', height: 10 }
      ]
    }
  ]);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].description, 'Validator churning paused');
  assert.equal(updates[0].height, 20);
});

test('governance votes are newest first with bounded progress', () => {
  const votes = getGovernanceVotes([
    {
      mimir_key: 'ADR26',
      mimir_category: 'economic',
      leader_value: '1',
      leader_count: 80,
      consensus_threshold: 67,
      consensus_ready: true,
      latest_vote_at: '2026-07-02T00:00:00Z'
    },
    {
      mimir_key: 'CONFIG',
      mimir_category: 'economic',
      leader_value: '10',
      leader_count: 20,
      consensus_threshold: 67,
      consensus_ready: false,
      latest_vote_at: '2026-07-03T00:00:00Z'
    },
    {
      mimir_key: 'EMPTY',
      mimir_category: 'economic',
      leader_value: '',
      leader_count: 0,
      consensus_threshold: 67,
      consensus_ready: false,
      latest_vote_at: '2026-07-04T00:00:00Z'
    }
  ]);

  assert.equal(votes[0].key, 'CONFIG');
  assert.equal(votes[1].progress, 100);
});
