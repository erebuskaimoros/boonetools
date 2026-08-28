import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';

function event(type, attrs) {
  return {
    type,
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: String(value)
    }))
  };
}

test('direct set_mimir safety events are parsed separately from validator votes', async () => {
  const { parseProtocolMimirChanges } = await import('../src/shared/protocol-mimir-changes.js');
  const changes = parseProtocolMimirChanges([
    event('security', {
      msg: 'missing tx out in=00E9274D6490CDFA326B18D06CF9EA6EC1DBA1759A3576D7F942FD43E9C9BC20'
    }),
    event('set_mimir', { key: 'HaltSigningSOL', value: '27591961' }),
    event('set_mimir', { key: 'HaltSOLTrading', value: '27591961' })
  ], {
    txId: 'ABC123',
    txIndex: 0,
    height: 27_591_961,
    blockTime: '2026-08-28T09:23:13.178Z',
    source: 'rpc'
  });

  assert.deepEqual(changes.map((row) => row.mimir_key), [
    'HALTSIGNINGSOL',
    'HALTSOLTRADING'
  ]);
  assert.equal(changes[0].mimir_value, '27591961');
  assert.equal(changes[0].change_source, 'protocol_safety');
  assert.equal(changes[0].source_label, 'Protocol safety event');
  assert.match(changes[0].security_message, /missing tx out/);
  assert.equal(changes[0].tx_id, 'ABC123');
  assert.equal(changes[0].height, 27_591_961);

  const voteDriven = parseProtocolMimirChanges([
    event('set_node_mimir', {
      key: 'HaltSigningSOL',
      value: '0',
      address: 'thor1validator'
    }),
    event('set_mimir', { key: 'HaltSigningSOL', value: '0' })
  ], { txId: 'VOTE123', height: 27_596_545 });
  assert.deepEqual(voteDriven, []);

  const differentDirectValue = parseProtocolMimirChanges([
    event('set_node_mimir', {
      key: 'HaltSigningSOL',
      value: '0',
      address: 'thor1validator'
    }),
    event('set_mimir', { key: 'HaltSigningSOL', value: '27591961' })
  ], { txId: 'SAFETY123', height: 27_591_961 });
  assert.equal(differentDirectValue.length, 1);
  assert.equal(differentDirectValue[0].mimir_value, '27591961');
  assert.equal(differentDirectValue[0].change_source, 'protocol_direct');
});

test('Effective Value History includes protocol safety changes without validator attribution', async () => {
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const historicalVotes = Array.from({ length: 3 }, (_, index) => ({
    mimir_key: 'HALTSIGNINGSOL',
    vote_value: '0',
    node_address: `thor1historical${index}`,
    operator_address: `thor1operator${index}`,
    block_time: `2026-06-21T11:2${index}:00.000Z`,
    height: 26_680_000 + index
  }));
  const currentZeroVotes = historicalVotes.slice(0, 2).map((row) => ({
    ...row,
    is_active: true,
    node_status: 'Active'
  }));
  const [group] = buildVoteGroups(
    historicalVotes,
    historicalVotes,
    { HALTSIGNINGSOL: 27_591_961 },
    95,
    3,
    { HALTSIGNINGSOL: currentZeroVotes },
    {
      currentNodeMimirsAvailable: true,
      protocolMimirChangesByKey: {
        HALTSIGNINGSOL: [{
          event_key: 'ABC123:1',
          tx_id: 'ABC123',
          height: 27_591_961,
          block_time: '2026-08-28T09:23:13.178Z',
          mimir_key: 'HALTSIGNINGSOL',
          mimir_value: '27591961',
          change_source: 'protocol_safety',
          source_label: 'Protocol safety event',
          security_message: 'missing tx out in=...BC20'
        }]
      }
    }
  );

  const directChange = group.effective_history[0];
  assert.equal(directChange.effective_value, '27591961');
  assert.equal(directChange.change_source, 'protocol_safety');
  assert.equal(directChange.source_label, 'Protocol safety event');
  assert.equal(directChange.security_message, 'missing tx out in=...BC20');
  assert.equal(directChange.height, 27_591_961);
  assert.equal(directChange.tx_id, 'ABC123');
  assert.equal('triggered_by_node' in directChange, false);
  assert.equal('leader_count' in directChange, false);
  assert.equal(group.current_value_changed_at, '2026-08-28T09:23:13.178+00:00');
  assert.ok(group.node_votes.every((row) => row.node_address));
});

test('a direct-only Mimir key still appears in By Vote without synthetic voters', async () => {
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const [group] = buildVoteGroups([], [], { HALTSOLTRADING: 27_591_961 }, 95, 3, {}, {
    currentNodeMimirsAvailable: true,
    protocolMimirChangesByKey: {
      HALTSOLTRADING: [{
        event_key: 'ABC123:2',
        tx_id: 'ABC123',
        height: 27_591_961,
        block_time: '2026-08-28T09:23:13.178Z',
        mimir_key: 'HALTSOLTRADING',
        mimir_value: '27591961',
        change_source: 'protocol_safety',
        source_label: 'Protocol safety event',
        security_message: 'missing tx out in=...BC20'
      }]
    }
  });

  assert.equal(group.mimir_key, 'HALTSOLTRADING');
  assert.deepEqual(group.node_votes, []);
  assert.deepEqual(group.vote_history, []);
  assert.equal(group.effective_history[0].change_source, 'protocol_safety');
  assert.equal(group.leader_count, 0);
});

test('a direct protocol change does not count as an economic validator pass', async () => {
  const { buildVoteGroups } = await import('../src/handlers/node-votes.js');
  const [group] = buildVoteGroups([], [], { ECONOMICSETTING: 42 }, 95, 3, {}, {
    currentNodeMimirsAvailable: true,
    protocolMimirChangesByKey: {
      ECONOMICSETTING: [{
        event_key: 'DIRECT123:1',
        tx_id: 'DIRECT123',
        height: 27_591_961,
        block_time: '2026-08-28T09:23:13.178Z',
        mimir_key: 'ECONOMICSETTING',
        mimir_value: '42',
        change_source: 'protocol_direct',
        source_label: 'Direct protocol event',
        security_message: ''
      }]
    }
  });

  assert.equal(group.mimir_category, 'economic');
  assert.equal(group.effective_history[0].change_source, 'protocol_direct');
  assert.equal(group.passed_at, null);
});

test('protocol Mimir backfill rolls from its own bounded watermark', async () => {
  const { runProtocolMimirBackfill } = await import('../src/shared/protocol-mimir-changes.js');
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('from node_vote_sync_state')) {
        return { rows: [{
          start_height: 25_000_000,
          start_time: '2026-02-28T00:00:00.000Z',
          end_time: '2026-08-20T00:00:00.000Z'
        }] };
      }
      return { rows: [] };
    }
  };
  let resolvedWindow = null;
  let eventQueries = null;
  const stats = await runProtocolMimirBackfill(client, {
    endTime: '2026-08-28T00:00:00.000Z',
    resolveHeightRange: async (startTime, endTime) => {
      resolvedWindow = { startTime, endTime };
      return { startHeight: 27_000_000, endHeight: 27_600_000 };
    },
    fetchTxs: async (_range, options) => {
      eventQueries = options.eventQueries;
      return { total: 0, txs: [] };
    }
  });

  assert.equal(stats.mode, 'rolling');
  assert.equal(resolvedWindow.startTime, '2026-08-06T00:00:00.000Z');
  assert.deepEqual(eventQueries, ['set_mimir.key EXISTS']);
  assert.ok(calls.some(({ sql }) => sql.includes('insert into "node_vote_sync_state"')));
});

test('protocol Mimir backfill reuses a confirmed height range without another RPC status lookup', async () => {
  const { runProtocolMimirBackfill } = await import('../src/shared/protocol-mimir-changes.js');
  const client = {
    async query(sql) {
      if (sql.includes('from node_vote_sync_state')) return { rows: [] };
      return { rows: [] };
    }
  };
  let fetchedRange = null;
  await runProtocolMimirBackfill(client, {
    startTime: '2026-08-14T00:00:00.000Z',
    endTime: '2026-08-28T00:00:00.000Z',
    startHeight: 27_584_001,
    endHeight: 27_597_399,
    resolveHeightRange: async () => {
      throw new Error('inconsistent RPC status must not be consulted');
    },
    fetchTxs: async (range) => {
      fetchedRange = range;
      return { total: 0, txs: [] };
    }
  });

  assert.deepEqual(fetchedRange, {
    startHeight: 27_584_001,
    endHeight: 27_597_399
  });
});

test('node-vote parent forwards its confirmed scan range to protocol Mimir backfill', async () => {
  const { buildProtocolMimirBackfillOptions } = await import('../src/shared/node-votes.js');
  assert.deepEqual(buildProtocolMimirBackfillOptions({
    startTime: '2026-08-14T00:00:00.000Z',
    endTime: '2026-08-28T00:00:00.000Z',
    startHeight: 27_584_001,
    endHeight: 27_597_399
  }), {
    startTime: '2026-08-14T00:00:00.000Z',
    endTime: '2026-08-28T00:00:00.000Z',
    startHeight: 27_584_001,
    endHeight: 27_597_399
  });

  assert.deepEqual(buildProtocolMimirBackfillOptions({
    startTime: '2026-08-14T00:00:00.000Z',
    endTime: '2026-08-28T00:00:00.000Z'
  }), {
    startTime: '2026-08-14T00:00:00.000Z',
    endTime: '2026-08-28T00:00:00.000Z'
  });
});
