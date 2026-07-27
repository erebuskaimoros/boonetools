import assert from 'node:assert/strict';
import test from 'node:test';

function event(type, attrs) {
  return {
    type,
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: String(value)
    }))
  };
}

test('parseNodeVoteEvents extracts set_node_mimir votes', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { parseNodeVoteEvents } = await import('../src/shared/node-votes.js');

  const rows = parseNodeVoteEvents([
    event('set_node_mimir', {
      key: 'L1SlipMinBps',
      value: '15',
      address: 'thor1nodeaddressxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }),
    event('swap', {
      id: 'ignored'
    })
  ], {
    txId: 'abc123',
    txIndex: 4,
    height: 123,
    blockTime: '2026-05-26T00:00:00.000Z',
    source: 'test'
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_key, 'ABC123:0');
  assert.equal(rows[0].mimir_key, 'L1SLIPMINBPS');
  assert.equal(rows[0].vote_value, '15');
  assert.equal(rows[0].vote_value_numeric, '15');
  assert.equal(rows[0].node_address, 'thor1nodeaddressxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(rows[0].height, 123);
  assert.equal(rows[0].source, 'test');
});

test('parseNodeVoteTxSearchTx handles tx_search rows', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { parseNodeVoteTxSearchTx } = await import('../src/shared/node-votes.js');

  const rows = parseNodeVoteTxSearchTx({
    hash: 'def456',
    height: '456',
    index: 2,
    tx_result: {
      events: [
        event('message', { action: '/types.MsgMimir' }),
        event('set_node_mimir', {
          key: 'ADR25',
          value: '1',
          address: 'thor1operatorvoteaddressxxxxxxxxxxxxxxxx'
        })
      ]
    }
  }, '2026-05-26T01:00:00.000Z');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_key, 'DEF456:1');
  assert.equal(rows[0].height, 456);
  assert.equal(rows[0].event_index, 1);
  assert.equal(rows[0].mimir_key, 'ADR25');
  assert.equal(rows[0].block_time, '2026-05-26T01:00:00.000Z');
});

test('Cosmos transaction responses paginate and preserve vote timestamps', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    fetchNodeVoteCosmosTxs,
    parseNodeVoteCosmosTxResponse
  } = await import('../src/shared/node-votes.js');
  const makeResponse = (txhash, height, timestamp, key) => ({
    txhash,
    height: String(height),
    timestamp,
    events: [event('set_node_mimir', {
      key,
      value: '1',
      address: 'thor1operatorvoteaddressxxxxxxxxxxxxxxxx'
    })]
  });
  const pages = [
    {
      total: '3',
      tx_responses: [
        makeResponse('abc123', 100, '2026-07-27T12:00:00Z', 'HALTBTCTRADING'),
        makeResponse('def456', 101, '2026-07-27T12:01:00Z', 'PAUSELP')
      ]
    },
    {
      total: '3',
      tx_responses: [
        makeResponse('ghi789', 102, '2026-07-27T12:02:00Z', 'HALTSIGNING')
      ]
    }
  ];
  const calls = [];

  const result = await fetchNodeVoteCosmosTxs(
    { startHeight: 100, endHeight: 102 },
    {
      limit: 2,
      fetchPage: async (page) => {
        calls.push(page);
        return pages[page - 1];
      }
    }
  );

  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.total, 3);
  assert.equal(result.txs.length, 3);
  assert.deepEqual(result.rows.map((row) => row.mimir_key), [
    'HALTBTCTRADING',
    'PAUSELP',
    'HALTSIGNING'
  ]);
  assert.equal(result.rows[2].block_time, '2026-07-27T12:02:00.000Z');
  assert.equal(result.rows[2].source, 'rpc');

  assert.equal(parseNodeVoteCosmosTxResponse({ events: [] }).length, 0);
});

test('resolveNodeVoteBackfillWindow uses recent lookback when votes already exist', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { resolveNodeVoteBackfillWindow } = await import('../src/shared/node-votes.js');

  const rolling = resolveNodeVoteBackfillWindow({
    endTime: '2026-06-26T13:00:00.000Z',
    latestStoredTime: '2026-06-21T11:51:30.465Z'
  });

  assert.equal(rolling.mode, 'rolling');
  assert.equal(rolling.lookbackDays, 14);
  assert.equal(rolling.startTime, '2026-06-07T11:51:30.465Z');
  assert.equal(rolling.endTime, '2026-06-26T13:00:00.000Z');

  const initial = resolveNodeVoteBackfillWindow({
    endTime: '2026-06-26T13:00:00.000Z',
    latestStoredTime: ''
  });

  assert.equal(initial.mode, 'full');
  assert.equal(initial.startTime, '2025-12-26T13:00:00.000Z');
});

test('buildValueBreakdown leads with largest vote count, not current value', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildValueBreakdown } = await import('../src/handlers/node-votes.js');

  const rows = [
    ...Array.from({ length: 28 }, (_, index) => ({
      vote_value: '0',
      node_address: `thor-node-zero-${index}`,
      operator_address: `thor-operator-zero-${index}`
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      vote_value: '7',
      node_address: `thor-node-seven-${index}`,
      operator_address: `thor-operator-seven-${index}`
    }))
  ];

  const values = buildValueBreakdown(rows, 7, 92, 62);

  assert.equal(values[0].value, '0');
  assert.equal(values[0].count, 28);
  assert.equal(values[1].value, '7');
  assert.equal(values[1].count, 12);
  assert.equal(values[1].is_active, true);
});

test('classifyMimirKey mirrors operational and economic mimir behavior', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { classifyMimirKey } = await import('../src/handlers/node-votes.js');

  assert.equal(classifyMimirKey('WASMARBSLIPMINBPS'), 'operational');
  assert.equal(classifyMimirKey('PauseLPDeposit-ETH-USDC'), 'operational');
  assert.equal(classifyMimirKey('MimirUpgradeContractAVAX'), 'operational');
  assert.equal(classifyMimirKey('AdvSwapQueueRapidSwapMax'), 'operational');
  assert.equal(classifyMimirKey('OverSolvencyToTreasuryBps'), 'operational');
  assert.equal(classifyMimirKey('EnableMemolessOutbound'), 'operational');
  assert.equal(classifyMimirKey('CompromisedVault-tthorpub1addwnpepq0'), 'operational');
  assert.equal(classifyMimirKey('POLReserveBlacklist-BTC-BTC'), 'operational');
  assert.equal(classifyMimirKey('DynamicFee-Whitelist-symbiosis'), 'operational');
  assert.equal(classifyMimirKey('RevShare-symbiosis'), 'operational');
  assert.equal(classifyMimirKey('EVMDirectERC20Inbound-ETH-USDC'), 'operational');
  assert.equal(classifyMimirKey('L1DynamicFeeEnabled'), 'operational');
  assert.equal(classifyMimirKey('L1DynamicFeeFloorBPS'), 'operational');
  assert.equal(classifyMimirKey('L1DynamicFeeWindowEpochs'), 'operational');
  assert.equal(classifyMimirKey('L1SlipMinBps-BTC-BTC'), 'operational');
  assert.equal(classifyMimirKey('StableSlipMinBps-ETH-USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'), 'operational');
  assert.equal(classifyMimirKey('SlipMinBpsMax'), 'economic');
  assert.equal(classifyMimirKey('SlipMinBpsMax-BTC-BTC'), 'economic');
  assert.equal(classifyMimirKey('POLReserveWhitelist-BTC-BTC'), 'economic');
  assert.equal(classifyMimirKey('ADR26'), 'economic');
  assert.equal(classifyMimirKey('SystemIncomePOL-Reserve'), 'economic');
  assert.equal(classifyMimirKey('BondSlashBan'), 'economic');
  assert.equal(classifyMimirKey('NodePauseChainBlocks'), 'economic');
});

test('buildActiveNodeOperators returns one operator record per active node', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildActiveNodeOperators } = await import('../src/handlers/node-votes.js');
  const nodes = [
    {
      node_address: 'thor-node-2',
      node_operator_address: 'thor-operator-2222',
      status: 'Active'
    },
    {
      node_address: 'thor-node-standby',
      node_operator_address: 'thor-operator-standby',
      status: 'Standby'
    },
    {
      node_address: 'thor-node-1',
      node_operator_address: 'thor-operator-1111',
      status: 'Active'
    },
    {
      node_address: 'thor-node-1',
      node_operator_address: 'thor-operator-1111',
      status: 'Active'
    }
  ];

  assert.deepEqual(buildActiveNodeOperators(nodes), [
    { node_address: 'thor-node-1', operator_address: 'thor-operator-1111' },
    { node_address: 'thor-node-2', operator_address: 'thor-operator-2222' }
  ]);
});

test('buildVoteGroups applies operational and economic thresholds separately', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const rows = [
    ...Array.from({ length: 3 }, (_, index) => ({
      mimir_key: 'PAUSELP',
      vote_value: '1',
      node_address: `thor-node-op-${index}`,
      operator_address: `thor-operator-op-${index}`,
      block_time: `2026-05-26T00:0${index}:00.000Z`,
      height: 100 + index
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      mimir_key: 'BONDSLASHBAN',
      vote_value: '1',
      node_address: `thor-node-econ-${index}`,
      operator_address: `thor-operator-econ-${index}`,
      block_time: `2026-05-26T00:1${index}:00.000Z`,
      height: 200 + index
    }))
  ];

  const groups = buildVoteGroups(rows, rows, {}, 90, 3);
  const operational = groups.find((row) => row.mimir_key === 'PAUSELP');
  const economic = groups.find((row) => row.mimir_key === 'BONDSLASHBAN');

  assert.equal(operational.mimir_category, 'operational');
  assert.equal(operational.consensus_threshold, 3);
  assert.equal(operational.consensus_ready, true);
  assert.equal(operational.vote_history.length, 3);
  assert.equal(operational.vote_history[0].height, 102);
  assert.equal(economic.mimir_category, 'economic');
  assert.equal(economic.consensus_threshold, 60);
  assert.equal(economic.consensus_ready, false);
});

test('buildVoteGroups counts economic consensus from live active node mimirs', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const rows = [
    {
      mimir_key: 'ADR26',
      vote_value: '1',
      node_address: 'thor-active-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:00:00.000Z',
      height: 100
    },
    {
      mimir_key: 'ADR26',
      vote_value: '1',
      node_address: 'thor-active-2',
      operator_address: 'thor-operator-2',
      block_time: '2026-05-26T00:01:00.000Z',
      height: 101
    },
    {
      mimir_key: 'ADR26',
      vote_value: '1',
      node_address: 'thor-standby-1',
      operator_address: 'thor-operator-standby',
      block_time: '2026-05-26T00:02:00.000Z',
      height: 102
    },
    {
      mimir_key: 'ADR26',
      vote_value: '1',
      node_address: 'thor-active-3',
      operator_address: 'thor-operator-3',
      block_time: '2026-05-26T00:03:00.000Z',
      height: 103
    },
    {
      mimir_key: 'ADR26',
      vote_value: '1',
      node_address: 'thor-active-4',
      operator_address: 'thor-operator-4',
      block_time: '2026-05-26T00:04:00.000Z',
      height: 104
    }
  ];

  const [group] = buildVoteGroups(
    rows,
    rows,
    { ADR26: 1 },
    5,
    3,
    {
      ADR26: [
        ...rows
          .filter((row) => row.node_address.startsWith('thor-active-'))
          .map((row) => ({
            mimir_key: row.mimir_key,
            node_address: row.node_address,
            operator_address: row.operator_address,
            node_status: 'Active',
            is_active: true,
            vote_value: row.vote_value
          })),
        {
          mimir_key: 'ADR26',
          node_address: 'thor-standby-1',
          operator_address: 'thor-operator-standby',
          node_status: 'Standby',
          is_active: false,
          vote_value: '1'
        }
      ]
    },
    { currentNodeMimirsAvailable: true }
  );

  assert.equal(group.mimir_category, 'economic');
  assert.equal(group.consensus_threshold, 4);
  assert.equal(group.leader_count, 4);
  assert.equal(group.latest_stance_count, 4);
  assert.equal(group.stored_latest_stance_count, 5);
  assert.equal(group.current_vote_source, 'thornode-active-node-mimir');
  assert.equal(group.consensus_ready, true);
  assert.equal(group.votes_to_consensus, 0);
  assert.equal(group.vote_history.length, 5);
  assert.deepEqual(group.values[0].nodes, [
    'thor-active-1',
    'thor-active-2',
    'thor-active-3',
    'thor-active-4'
  ]);
  assert.equal(group.passed_at, '2026-05-26T00:04:00.000+00:00');
  assert.equal(group.effective_history[0].height, 104);
});

test('buildVoteGroups treats negative node mimir values as removed votes', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const rows = [
    {
      mimir_key: 'PAUSELP',
      vote_value: '1',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:00:00.000Z',
      height: 100
    },
    {
      mimir_key: 'PAUSELP',
      vote_value: '-1',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:01:00.000Z',
      height: 101
    },
    {
      mimir_key: 'PAUSELP',
      vote_value: '1',
      node_address: 'thor-node-2',
      operator_address: 'thor-operator-2',
      block_time: '2026-05-26T00:02:00.000Z',
      height: 102
    }
  ];

  const [group] = buildVoteGroups(rows, [rows[2]], {}, 10, 2);

  assert.equal(group.latest_stance_count, 1);
  assert.equal(group.leader_count, 1);
  assert.equal(group.consensus_ready, false);
  assert.equal(group.node_votes.length, 2);
  assert.equal(group.node_votes[0].node_address, 'thor-node-2');
  assert.equal(group.node_votes[0].height, 102);
  assert.equal(group.node_votes.find((vote) => vote.node_address === 'thor-node-1').vote_removed, true);
});

test('buildVoteGroups counts changed operational votes once from live active node mimirs', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const rows = [
    {
      mimir_key: 'HALTTRADING',
      vote_value: '1',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:00:00.000Z',
      height: 100
    },
    {
      mimir_key: 'HALTTRADING',
      vote_value: '1',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:01:00.000Z',
      height: 101
    },
    {
      mimir_key: 'HALTTRADING',
      vote_value: '2',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:02:00.000Z',
      height: 102
    },
    {
      mimir_key: 'HALTTRADING',
      vote_value: '2',
      node_address: 'thor-node-2',
      operator_address: 'thor-operator-2',
      block_time: '2026-05-26T00:03:00.000Z',
      height: 103
    },
    {
      mimir_key: 'HALTTRADING',
      vote_value: '1',
      node_address: 'thor-node-3',
      operator_address: 'thor-operator-3',
      block_time: '2026-05-26T00:04:00.000Z',
      height: 104
    }
  ];

  const [group] = buildVoteGroups(
    rows,
    [rows[2], rows[3], rows[4]],
    { HALTTRADING: 2 },
    2,
    2,
    {
      HALTTRADING: [
        {
          mimir_key: 'HALTTRADING',
          node_address: 'thor-node-1',
          node_status: 'Active',
          is_active: true,
          vote_value: '2'
        },
        {
          mimir_key: 'HALTTRADING',
          node_address: 'thor-node-2',
          node_status: 'Active',
          is_active: true,
          vote_value: '2'
        },
        {
          mimir_key: 'HALTTRADING',
          node_address: 'thor-node-3',
          node_status: 'Standby',
          is_active: false,
          vote_value: '1'
        }
      ]
    },
    { currentNodeMimirsAvailable: true }
  );

  assert.equal(group.current_vote_source, 'thornode-active-node-mimir');
  assert.equal(group.stored_latest_stance_count, 3);
  assert.equal(group.latest_stance_count, 2);
  assert.deepEqual(group.values.map(({ value, count }) => ({ value, count })), [
    { value: '2', count: 2 }
  ]);
  assert.equal(group.consensus_ready, true);
  assert.equal(group.repeated_vote_events, 2);
  assert.equal(group.value_change_events, 1);
});

test('buildEffectiveValueHistory records effective value changes over time', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildEffectiveValueHistory } = await import('../src/handlers/node-votes.js');
  const rows = [
    {
      mimir_key: 'PAUSELP',
      vote_value: '1',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:00:00.000Z',
      height: 100
    },
    {
      mimir_key: 'PAUSELP',
      vote_value: '1',
      node_address: 'thor-node-2',
      operator_address: 'thor-operator-2',
      block_time: '2026-05-26T00:01:00.000Z',
      height: 101
    },
    {
      mimir_key: 'PAUSELP',
      vote_value: '2',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-1',
      block_time: '2026-05-26T00:02:00.000Z',
      height: 102
    },
    {
      mimir_key: 'PAUSELP',
      vote_value: '2',
      node_address: 'thor-node-3',
      operator_address: 'thor-operator-3',
      block_time: '2026-05-26T00:03:00.000Z',
      height: 103
    }
  ];

  const history = buildEffectiveValueHistory(rows, {
    category: 'operational',
    threshold: 2,
    activeNodeCount: 10
  });

  assert.deepEqual(
    history.map((row) => row.effective_value),
    ['2', '1']
  );
  assert.equal(history[0].height, 103);
  assert.equal(history[1].height, 101);
});

test('buildVoteGroups records operational current value and votes from current node mimirs', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const zeroVotes = Array.from({ length: 4 }, (_, index) => ({
    mimir_key: 'WASMARBSLIPMINBPS',
    vote_value: '0',
    node_address: `thor-node-zero-${index}`,
    operator_address: `thor-operator-zero-${index}`,
    block_time: `2026-05-26T00:0${index}:00.000Z`,
    height: 100 + index
  }));
  const currentVotes = Array.from({ length: 3 }, (_, index) => ({
    mimir_key: 'WASMARBSLIPMINBPS',
    vote_value: '7',
    node_address: `thor-node-seven-${index}`,
    operator_address: `thor-operator-seven-${index}`,
    block_time: `2026-05-26T01:0${index}:00.000Z`,
    height: 200 + index
  }));
  const rows = [...zeroVotes, ...currentVotes];
  const [group] = buildVoteGroups(
    rows,
    rows,
    { WASMARBSLIPMINBPS: 7 },
    92,
    3,
    {
      WASMARBSLIPMINBPS: currentVotes.map((row) => ({
        mimir_key: row.mimir_key,
        node_address: row.node_address,
        node_status: 'Active',
        is_active: true,
        vote_value: row.vote_value
      }))
    },
    { currentNodeMimirsAvailable: true }
  );

  assert.equal(group.leader_value, '7');
  assert.equal(group.leader_count, 3);
  assert.equal(group.current_vote_source, 'thornode-active-node-mimir');
  assert.equal(group.current_value_changed_at, '2026-05-26T01:02:00.000+00:00');
  assert.equal(group.effective_history[0].effective_value, '7');
  assert.equal(group.effective_history[0].inferred_from_current_node_mimirs, true);
});

test('buildNodeGroups creates node rollups for the node page', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildNodeGroups } = await import('../src/handlers/node-votes.js');
  const rows = [
    {
      mimir_key: 'PAUSELP',
      mimir_category: 'operational',
      vote_value: '1',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-a',
      node_status: 'Active',
      block_time: '2026-05-26T00:00:00.000Z',
      height: 100
    },
    {
      mimir_key: 'BONDSLASHBAN',
      mimir_category: 'economic',
      vote_value: '1',
      node_address: 'thor-node-1',
      operator_address: 'thor-operator-a',
      node_status: 'Active',
      block_time: '2026-05-26T00:01:00.000Z',
      height: 101
    },
    {
      mimir_key: 'PAUSELP',
      mimir_category: 'operational',
      vote_value: '1',
      node_address: 'thor-node-2',
      operator_address: 'thor-operator-b',
      node_status: 'Standby',
      block_time: '2026-05-26T00:02:00.000Z',
      height: 102
    }
  ];

  const groups = buildNodeGroups(rows, rows);
  const top = groups.find((row) => row.node_address === 'thor-node-1');

  assert.equal(groups.length, 2);
  assert.equal(top.operator_address, 'thor-operator-a');
  assert.equal(top.unique_keys, 2);
  assert.equal(top.category_counts.operational, 1);
  assert.equal(top.category_counts.economic, 1);
  assert.equal(top.avg_response_time_ms, 0);
  assert.equal(top.economic_vote_key_count, 1);
  assert.equal(top.economic_tracked_key_count, 1);
  assert.equal(top.economic_voted_percent, 100);
  assert.equal(top.vote_history.length, 2);
  assert.deepEqual(top.vote_history.map((vote) => vote.mimir_key), ['BONDSLASHBAN', 'PAUSELP']);
  assert.equal(top.vote_history[0].mimir_category, 'economic');

  const standby = groups.find((row) => row.node_address === 'thor-node-2');
  assert.equal(standby.avg_response_time_ms, 120000);
  assert.equal(standby.economic_vote_key_count, 0);
  assert.equal(standby.economic_voted_percent, 0);
});
