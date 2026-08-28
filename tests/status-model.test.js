import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChainStatuses,
  buildChurnStatus,
  buildStatusNetworkReadModel,
  getGovernanceVotes,
  getRecentStatusUpdates,
  isHeightMimirActive,
  summarizeNetwork
} from '../shared/status/model.js';

test('live status model contains only compact current network state', () => {
  const payload = buildStatusNetworkReadModel({
    generatedAt: '2026-07-21T12:00:01Z',
    networkSnapshot: {
      inbound_addresses: [{ chain: 'BTC' }, { chain: 'ETH', chain_trading_paused: true }],
      nodes: [
        { status: 'Active', version: '3.19.0', status_since: 900 },
        { status: 'Active', version: '3.19.0', status_since: 901 }
      ],
      mimir: { HALTCHURNING: 1 },
      lastblock: [
        { chain: 'BTC', thorchain: 1000, last_observed_in: 50, last_signed_out: 49 },
        { chain: 'ETH', thorchain: 1000, last_observed_in: 60, last_signed_out: 58 }
      ],
      churns: [{ height: 900, date: 1_721_304_000_000_000_000 }],
      as_of: '2026-07-21T12:00:00Z',
      source: { live: 'thornode', churns: 'midgard' },
      partial: false,
      stale: false
    }
  });

  assert.equal(payload.network.height, 1000);
  assert.equal(payload.network.active_node_count, 2);
  assert.equal(payload.network.majority_version, '3.19.0');
  assert.equal(payload.network.summary.label, 'Degraded');
  assert.equal(payload.chains.length, 2);
  assert.equal(payload.churn.isPaused, true);
  assert.equal(payload.source.as_of, '2026-07-21T12:00:00.000Z');
  assert.equal(payload.block_production, undefined);
  assert.equal(payload.votes, undefined);
  assert.equal(payload.stuck_transactions, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 5_000);
});

test('live status reports a consensus stall even when every Mimir lane looks operational', () => {
  const payload = buildStatusNetworkReadModel({
    generatedAt: '2026-08-26T12:05:00Z',
    latestBlock: {
      height: 27_500_000,
      time: '2026-08-26T12:00:00Z',
      source: 'liquify-thorchain-block-headers'
    },
    networkSnapshot: {
      inbound_addresses: [{ chain: 'BTC' }, { chain: 'ETH' }],
      nodes: [{ status: 'Active', version: '3.20.0', status_since: 27_400_000 }],
      mimir: {
        HALTTRADING: 0,
        HALTSIGNING: 0,
        HALTCHAINGLOBAL: 0
      },
      lastblock: [
        { chain: 'BTC', thorchain: 27_500_000 },
        { chain: 'ETH', thorchain: 27_500_000 }
      ],
      churns: [],
      as_of: '2026-08-26T12:05:00Z',
      source: { live: 'thornode', churns: 'midgard' },
      partial: false,
      stale: false
    }
  });

  assert.equal(payload.network.consensus.state, 'stalled');
  assert.equal(payload.network.consensus.signing_blocks, false);
  assert.equal(payload.network.consensus.last_block_at, '2026-08-26T12:00:00.000Z');
  assert.equal(payload.network.consensus.block_age_seconds, 300);
  assert.equal(payload.network.summary.label, 'Stalled');
  assert.equal(payload.network.summary.tone, 'err');
});

test('consensus liveness separates normal slow blocks from delay and stall states', () => {
  const networkSnapshot = {
    inbound_addresses: [{ chain: 'BTC' }],
    nodes: [{ status: 'Active', version: '3.20.0' }],
    mimir: {},
    lastblock: [{ chain: 'BTC', thorchain: 100 }],
    churns: [],
    as_of: '2026-08-26T12:00:00Z'
  };
  const buildAt = (generatedAt) => buildStatusNetworkReadModel({
    generatedAt,
    latestBlock: { height: 100, time: '2026-08-26T12:00:00Z' },
    networkSnapshot
  });

  assert.equal(buildAt('2026-08-26T12:00:29Z').network.consensus.state, 'signing');
  assert.equal(buildAt('2026-08-26T12:00:30Z').network.consensus.state, 'delayed');
  assert.equal(buildAt('2026-08-26T12:01:29Z').network.consensus.state, 'delayed');
  assert.equal(buildAt('2026-08-26T12:01:30Z').network.consensus.state, 'stalled');
  assert.equal(buildAt('2026-08-26T11:59:59Z').network.consensus.block_age_seconds, 0);
});

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
    lpActions: 'paused',
    signing: 'enabled',
    lastObservedIn: 900,
    lastSignedOut: 95,
    thorchainHeight: 100,
    tipHeight: 0,
    avgBlocksBehindTip: null,
    reportingValidators: 0,
    degraded: true
  });
  assert.equal(rows[1].trading, 'paused');
  assert.equal(rows[1].deposits, 'partial');
  assert.equal(rows[1].withdrawals, 'enabled');
  assert.equal(rows[1].lpActions, 'partial');
  assert.equal(rows[1].signing, 'enabled');
});

test('chain status does not fall back to stale observe-chain heights without scanner reports', () => {
  const rows = buildChainStatuses([
    { chain: 'BTC' },
    { chain: 'ETH' }
  ], {}, [
    { chain: 'BTC', thorchain: 100 },
    { chain: 'ETH', thorchain: 100 }
  ], [
    {
      status: 'Active',
      observe_chains: [
        { chain: 'BTC', height: 100 },
        { chain: 'ETH', height: 200 }
      ]
    },
    {
      status: 'Active',
      observe_chains: [
        { chain: 'BTC', height: 96 },
        { chain: 'ETH', height: 198 }
      ]
    },
    {
      status: 'Active',
      observe_chains: [{ chain: 'BTC', height: 94 }]
    },
    {
      status: 'Standby',
      observe_chains: [
        { chain: 'BTC', height: 1_000 },
        { chain: 'ETH', height: 1_000 }
      ]
    }
  ]);

  assert.deepEqual(rows.map((row) => ({
    chain: row.chain,
    tipHeight: row.tipHeight,
    avgBlocksBehindTip: row.avgBlocksBehindTip,
    reportingValidators: row.reportingValidators
  })), [
    { chain: 'BTC', tipHeight: 0, avgBlocksBehindTip: null, reportingValidators: 0 },
    { chain: 'ETH', tipHeight: 0, avgBlocksBehindTip: null, reportingValidators: 0 }
  ]);
});

test('chain status uses Bifrost scanner lag instead of stale observe-chain heights', () => {
  const rows = buildChainStatuses([
    { chain: 'SOL' }
  ], {}, [
    { chain: 'SOL', thorchain: 100 }
  ], [
    {
      node_address: 'thor1activea',
      status: 'Active',
      observe_chains: [{ chain: 'SOL', height: 1_000 }]
    },
    {
      node_address: 'thor1activeb',
      status: 'Active',
      observe_chains: [{ chain: 'SOL', height: 100 }]
    },
    {
      node_address: 'thor1standby',
      status: 'Standby',
      observe_chains: [{ chain: 'SOL', height: 2_000 }]
    }
  ], [
    {
      node_address: 'thor1activea',
      scanner: {
        SOL: {
          chain: 'SOL',
          chain_height: 2_000,
          block_scanner_height: 1_996,
          scanner_height_diff: 4,
          healthy: true
        }
      }
    },
    {
      node_address: 'thor1activeb',
      scanner: {
        SOL: {
          chain: 'SOL',
          chain_height: 2_000,
          block_scanner_height: 1_994,
          scanner_height_diff: 6,
          healthy: true
        }
      }
    },
    {
      node_address: 'thor1standby',
      scanner: {
        SOL: {
          chain: 'SOL',
          chain_height: 2_000,
          block_scanner_height: 1_000,
          scanner_height_diff: 1_000,
          healthy: false
        }
      }
    }
  ]);

  assert.deepEqual(rows.map((row) => ({
    chain: row.chain,
    tipHeight: row.tipHeight,
    avgBlocksBehindTip: row.avgBlocksBehindTip,
    reportingValidators: row.reportingValidators
  })), [
    { chain: 'SOL', tipHeight: 2_000, avgBlocksBehindTip: 5, reportingValidators: 2 }
  ]);
});

test('chain status excludes missing, invalid, and negative scanner diffs', () => {
  const rows = buildChainStatuses([{ chain: 'SOL' }], {}, [], [
    { node_address: 'thor1a', status: 'Active' },
    { node_address: 'thor1b', status: 'Active' },
    { node_address: 'thor1c', status: 'Active' },
    { node_address: 'thor1d', status: 'Active' }
  ], [
    { node_address: 'thor1a', scanner: { SOL: { chain_height: 500, scanner_height_diff: 1 } } },
    { node_address: 'thor1b', scanner: { SOL: { chain_height: 800, scanner_height_diff: -1 } } },
    { node_address: 'thor1c', scanner: { SOL: { chain_height: 900 } } },
    { node_address: 'thor1d', scanner: { SOL: { chain_height: 700, scanner_height_diff: 'bad' } } },
    { node_address: 'thor1unknown', scanner: { SOL: { chain_height: 1_000, scanner_height_diff: 99 } } }
  ]);

  assert.deepEqual(rows.map((row) => ({
    tipHeight: row.tipHeight,
    avgBlocksBehindTip: row.avgBlocksBehindTip,
    reportingValidators: row.reportingValidators
  })), [{ tipHeight: 500, avgBlocksBehindTip: 1, reportingValidators: 1 }]);
});

test('network summary is degraded when any chain action is unavailable', () => {
  const summary = summarizeNetwork([
    { chain: 'BTC', trading: 'enabled', deposits: 'enabled', withdrawals: 'enabled', lpActions: 'enabled', signing: 'enabled', degraded: false },
    { chain: 'SOL', trading: 'paused', deposits: 'paused', withdrawals: 'paused', lpActions: 'paused', signing: 'enabled', degraded: true }
  ]);

  assert.equal(summary.label, 'Degraded');
  assert.equal(summary.tradingEnabled, 1);
  assert.equal(summary.lpEnabled, 1);
  assert.equal(summary.signingEnabled, 2);
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
  assert.equal(row.lpActions, 'paused');
  assert.equal(row.signing, 'paused');
});

test('signing halts remain independent from trading and LP state', () => {
  const rows = buildChainStatuses([
    {
      chain: 'BTC',
      halted: false,
      global_trading_paused: false,
      chain_trading_paused: false,
      chain_lp_actions_paused: false
    },
    {
      chain: 'ETH',
      halted: false,
      global_trading_paused: false,
      chain_trading_paused: false,
      chain_lp_actions_paused: false
    }
  ], {
    HALTSIGNINGBTC: 1,
    HALTSIGNINGETH: 101
  }, [
    { chain: 'BTC', thorchain: 100 },
    { chain: 'ETH', thorchain: 100 }
  ]);

  assert.equal(rows[0].trading, 'enabled');
  assert.equal(rows[0].lpActions, 'enabled');
  assert.equal(rows[0].signing, 'paused');
  assert.equal(rows[1].signing, 'enabled');
});

test('churn status uses latest Midgard churn and height-aware halt state', () => {
  const now = Date.UTC(2026, 6, 12, 12);
  const timestampMs = now - (14 * 24 * 60 * 60 * 1000);
  const status = buildChurnStatus({ HALTCHURNING: 1 }, 200, [
    { height: '150', date: String(timestampMs * 1_000_000) },
    { height: '100', date: String((timestampMs - 1_000) * 1_000_000) }
  ], [], now);

  assert.equal(status.isPaused, true);
  assert.equal(status.lastChurnHeight, 150);
  assert.equal(status.lastChurnTimestampMs, timestampMs);
  assert.equal(status.blocksSince, 50);
  assert.equal(status.estimated, false);
});

test('churn status falls back to active-set height when history is unavailable', () => {
  const now = Date.UTC(2026, 6, 12, 12);
  const status = buildChurnStatus({ HALTCHURNING: 201 }, 200, [], [
    { status_since: 120 },
    { status_since: 180 }
  ], now);

  assert.equal(status.isPaused, false);
  assert.equal(status.lastChurnHeight, 180);
  assert.equal(status.lastChurnTimestampMs, now - 120_000);
  assert.equal(status.estimated, true);
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

test('network changes include newer effective non-halt Mimirs', () => {
  const updates = getRecentStatusUpdates([
    {
      mimir_key: 'HALTBASETRADING',
      effective_history: [{ effective_value: '1', block_time: '2026-07-17T16:30:00Z', height: 100 }]
    },
    {
      mimir_key: 'ADVSWAPQUEUERAPIDSWAPMAX',
      effective_history: [{ effective_value: '3', block_time: '2026-07-24T20:21:00Z', height: 200 }]
    }
  ]);

  assert.deepEqual(updates.map((update) => update.key), [
    'ADVSWAPQUEUERAPIDSWAPMAX',
    'HALTBASETRADING'
  ]);
  assert.equal(updates[0].description, 'ADVSWAPQUEUERAPIDSWAPMAX set to 3');
  assert.equal(updates[0].tone, 'ok');
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
