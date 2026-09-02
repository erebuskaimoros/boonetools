import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionDatabase } from './fixtures/acquisition-db.js';
process.env.DATABASE_URL ||= 'postgresql://fixture:fixture@127.0.0.1:5433/fixture';

test('empty verified vote windows advance independently of matching events and failed lanes', async () => {
  const { loadVoteScan, saveVoteScan, voteScanWindow } = await import('../src/shared/node-vote-acquisition.js');
  const client = acquisitionDatabase();
  const endTime = '2026-09-02T12:00:00.000Z';
  await saveVoteScan(client, 'upgrades', { endHeight: 12345, endTime, startHeight: 10000, startTime: '2026-09-01T12:00:00.000Z' });
  const previous = await loadVoteScan(client, 'upgrades');
  const range = voteScanWindow({ previous, endTime: '2026-09-02T13:00:00.000Z', fullStartTime: '2026-03-02T00:00:00.000Z' });
  assert.equal(range.startHeight, 12345 - 600);
  assert.equal(range.startTime, '2026-09-02T11:00:00.000Z');
  assert.equal(await loadVoteScan(client, 'mimir'), null);
  await assert.rejects(saveVoteScan(client, 'upgrades', { ...previous, complete: false }), /incomplete/i);
  assert.equal((await loadVoteScan(client, 'upgrades')).endHeight, 12345);
});

test('vote scan bootstrap retains the full window, and Dune keeps a bounded late-index overlap', async () => {
  const { voteScanWindow } = await import('../src/shared/node-vote-acquisition.js');
  const initial = voteScanWindow({ fullStartTime: '2026-03-02T00:00:00.000Z', endTime: '2026-09-02T12:00:00.000Z' });
  assert.equal(initial.startTime, '2026-03-02T00:00:00.000Z');
  assert.equal(initial.startHeight, 0);
  const dune = voteScanWindow({ previous: { endTime: '2026-09-02T12:00:00.000Z', endHeight: 12345 },
    fullStartTime: initial.startTime, endTime: '2026-09-02T13:00:00.000Z', overlapMs: 86_400_000 });
  assert.equal(dune.startTime, '2026-09-01T12:00:00.000Z');
});

test('truncated transaction searches cannot be mistaken for completed empty history', async () => {
  const { fetchNodeVoteTxs } = await import('../src/shared/node-votes.js');
  await assert.rejects(fetchNodeVoteTxs({ startHeight: 1, endHeight: 100 }, {
    fetchPage: async () => ({ total: 3, txs: [] })
  }), /incomplete|truncated/i);
});

test('the vote job advances successful empty lanes and resumes a failed upgrade scan from its prior coverage', async () => {
  const { runNodeVoteBackfill } = await import('../src/shared/node-votes.js');
  const { loadVoteScan } = await import('../src/shared/node-vote-acquisition.js');
  const cache = acquisitionDatabase();
  const client = { query: (sql, params) => sql.includes('node_vote_sync_state')
    ? Promise.resolve({ rows: [] }) : cache.query(sql, params) };
  const primary = [];
  const upgrades = [];
  const options = {
    endTime: '2026-09-02T12:00:00.000Z',
    fetchRpcRows: async (start, end) => { primary.push(start); return { rows: [], total: 0, txs: [], startHeight: 10000, endHeight: 12000 + (primary.length - 1) * 1000, endTime: end }; },
    fetchUpgradeRows: async (start, end, scan) => {
      upgrades.push({ start, height: scan.startHeight });
      if (upgrades.length > 1) throw new Error('archive temporarily unavailable');
      return { rows: [], total: 0, txs: [], startHeight: 10000, endHeight: 12000, endTime: end };
    },
    enrichRows: async (rows) => rows, upsertVotes: async () => 0,
    runProtocolBackfill: async () => ({ event_count: 0 })
  };
  await runNodeVoteBackfill(client, options);
  const result = await runNodeVoteBackfill(client, { ...options, endTime: '2026-09-02T13:00:00.000Z' });
  assert.equal(primary[1], '2026-09-02T11:00:00.000Z');
  assert.deepEqual(upgrades[1], { start: '2026-09-02T11:00:00.000Z', height: 11400 });
  assert.equal((await loadVoteScan(client, 'upgrades')).endHeight, 12000);
  assert.equal((await loadVoteScan(client, 'mimir')).endTime, '2026-09-02T13:00:00.000Z');
  assert.equal(result.upgrade_history_status, 'degraded');
});

test('duplicate RPC transaction pages cannot satisfy verified scan coverage', async () => {
  const { fetchNodeVoteTxs } = await import('../src/shared/node-votes.js');
  await assert.rejects(fetchNodeVoteTxs({ startHeight: 1, endHeight: 100 }, {
    fetchPage: async () => ({ total: 2, txs: [{ hash: 'A', height: '10', index: 0 }] })
  }), /duplicate|incomplete/i);
});

test('changing Cosmos totals cannot satisfy verified scan coverage', async () => {
  const { fetchNodeVoteCosmosTxs } = await import('../src/shared/node-votes.js');
  await assert.rejects(fetchNodeVoteCosmosTxs({ startHeight: 1, endHeight: 100 }, {
    fetchPage: async (page) => ({ total: page === 1 ? '2' : '1', tx_responses: [{ txhash: String(page), height: '10' }] })
  }), /changing|inconsistent|incomplete/i);
});

function scanClient() {
  const cache = acquisitionDatabase();
  return { query: (sql, params) => sql.includes('node_vote_sync_state') ? Promise.resolve({ rows: [] }) : cache.query(sql, params) };
}
function failingPrimaryOptions(overrides = {}) {
  return { endTime: '2026-09-02T12:00:00Z',
    fetchDuneRows: async () => { throw new Error('Dune unavailable'); },
    fetchCosmosRows: async () => { throw new Error('Cosmos unavailable'); },
    fetchRpcRows: async () => { throw new Error('RPC unavailable'); },
    enrichRows: async (rows) => rows, upsertVotes: async () => 0,
    fetchUpgradeRows: async () => ({ rows: [], total: 0, txs: [], startHeight: 100, endHeight: 200, endTime: '2026-09-02T11:59:00Z' }),
    runProtocolBackfill: async () => ({ event_count: 0 }), ...overrides };
}

test('failed Mimir acquisition does not prevent independent upgrade and protocol progress', async () => {
  const { runNodeVoteBackfill } = await import('../src/shared/node-votes.js');
  const { loadVoteScan } = await import('../src/shared/node-vote-acquisition.js');
  const client = scanClient();
  let protocols = 0;
  const result = await runNodeVoteBackfill(client, failingPrimaryOptions({
    runProtocolBackfill: async () => { protocols++; return { event_count: 0 }; }
  }));
  assert.equal(protocols, 1);
  assert.equal(result.mimir_history_status, 'degraded');
  assert.equal((await loadVoteScan(client, 'upgrades')).endHeight, 200);
  assert.equal(await loadVoteScan(client, 'mimir'), null);
});

test('a Dune result without a source index watermark cannot advance verified coverage', async () => {
  const { runNodeVoteBackfill } = await import('../src/shared/node-votes.js');
  const { loadVoteScan } = await import('../src/shared/node-vote-acquisition.js');
  const client = scanClient();
  await runNodeVoteBackfill(client, failingPrimaryOptions({ fetchDuneRows: async () => ({ rows: [], executionId: 'lagged-index' }) }));
  assert.equal(await loadVoteScan(client, 'mimir'), null);
});

function rpcStatus(height = 200) {
  return { result: { node_info: { other: { tx_index: 'on' } }, sync_info: {
    catching_up: false, earliest_block_height: '1', earliest_block_time: '2026-01-01T00:00:00Z',
    latest_block_height: String(height), latest_block_time: '2026-09-02T11:59:00Z'
  } } };
}

test('vote coverage uses the transaction provider head rather than a newer local listener head', async () => {
  const { resolveNodeVoteHeightRange } = await import('../src/shared/node-votes.js');
  const range = await resolveNodeVoteHeightRange('2026-09-02T10:00:00Z', '2026-09-02T12:00:00Z', {
    client: {}, startHeight: 100, rpcUrls: ['https://archive.invalid'],
    resolveHead: async () => ({ height: 300, blockTime: '2026-09-02T12:00:00Z' }),
    fetchStatus: async () => rpcStatus(200)
  });
  assert.equal(range.endHeight, 200);
  assert.equal(range.endTime, '2026-09-02T11:59:00.000Z');
  assert.deepEqual(range.rpcUrls, ['https://archive.invalid']);
});

test('a pruned provider cannot certify a vote range that starts before its retained blocks', async () => {
  const { resolveNodeVoteHeightRange } = await import('../src/shared/node-votes.js');
  const status = rpcStatus();
  status.result.sync_info.earliest_block_time = '2026-09-02T11:00:00Z';
  status.result.sync_info.earliest_block_height = '190';
  await assert.rejects(resolveNodeVoteHeightRange('2026-08-01T00:00:00Z', '2026-09-02T12:00:00Z', {
    allowPartialHistory: false, rpcUrls: ['https://archive.invalid'], fetchStatus: async () => status
  }), /retained|pruned|coverage/i);
});

test('legacy vote sync status remains incomplete when only independent lanes succeed', async () => {
  const { runNodeVoteBackfill } = await import('../src/shared/node-votes.js');
  const cache = acquisitionDatabase();
  let complete;
  const client = { query: async (sql, params) => {
    if (sql.includes('node_vote_sync_state')) {
      if (sql.startsWith('insert')) complete = params[6];
      return { rows: [] };
    }
    return cache.query(sql, params);
  } };
  await runNodeVoteBackfill(client, failingPrimaryOptions());
  assert.equal(complete, false);
});

test('independent vote lanes share one provider-specific status observation per run', async () => {
  const { runNodeVoteBackfill } = await import('../src/shared/node-votes.js');
  const { saveVoteScan } = await import('../src/shared/node-vote-acquisition.js');
  const client = scanClient();
  for (const lane of ['mimir', 'upgrades']) {
    await saveVoteScan(client, lane, { startHeight: 1, endHeight: 700, startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T11:00:00Z' });
  }
  let statuses = 0;
  const rangeResult = async (start, end, options) => ({
    ...await options.resolveRange(start, end, options), rows: [], txs: [], total: 0
  });
  await runNodeVoteBackfill(client, {
    endTime: '2026-09-02T12:00:00Z', fetchStatus: async () => { statuses++; return rpcStatus(1000); },
    fetchRpcRows: rangeResult, fetchUpgradeRows: rangeResult,
    enrichRows: async (rows) => rows, upsertVotes: async () => 0,
    runProtocolBackfill: async (_client, options) => {
      await options.resolveHeightRange('2026-09-02T10:30:00Z', '2026-09-02T12:00:00Z', { client, startHeight: 200 });
      return { event_count: 0 };
    }
  });
  assert.equal(statuses, 1);
});

test('when all archives are pruned, vote scanning uses the best retained range and records the older gap', async () => {
  const { resolveNodeVoteHeightRange } = await import('../src/shared/node-votes.js');
  const attempts = [];
  const status = rpcStatus(1000);
  status.result.sync_info.earliest_block_height = '800';
  status.result.sync_info.earliest_block_time = '2026-08-26T07:02:24Z';
  const range = await resolveNodeVoteHeightRange('2026-03-02T12:00:00Z', '2026-09-02T12:00:00Z', {
    allowPartialHistory: true, rpcUrls: ['https://expired.invalid', 'https://working.invalid'],
    fetchStatus: async (options) => {
      attempts.push(options.rpcUrls[0]);
      if (options.rpcUrls[0].includes('expired')) throw new Error('certificate expired');
      return status;
    }
  });
  assert.equal(range.startHeight, 800);
  assert.equal(range.endHeight, 1000);
  assert.equal(range.coverageStartTime, '2026-08-26T07:02:24.000Z');
  assert.equal(range.requestedStartTime, '2026-03-02T12:00:00.000Z');
  assert.equal(range.historyComplete, false);
  assert.deepEqual(attempts, ['https://expired.invalid', 'https://working.invalid']);
});

test('verified recent progress preserves the older history gap across later incremental scans', async () => {
  const { saveVoteScan, loadVoteScan } = await import('../src/shared/node-vote-acquisition.js');
  const client = acquisitionDatabase();
  await saveVoteScan(client, 'upgrades', {
    requestedStartTime: '2026-03-02T12:00:00Z', startHeight: 800, endHeight: 1000,
    startTime: '2026-08-26T07:02:24Z', coverageStartTime: '2026-08-26T07:02:24Z',
    endTime: '2026-09-02T12:00:00Z', source: 'rpc'
  });
  await saveVoteScan(client, 'upgrades', {
    startHeight: 900, endHeight: 1100, startTime: '2026-09-02T11:00:00Z', endTime: '2026-09-02T13:00:00Z', source: 'rpc'
  });
  const record = await loadVoteScan(client, 'upgrades');
  assert.equal(record.endHeight, 1100);
  assert.equal(record.coverageStartHeight, 800);
  assert.equal(record.coverageStartTime, '2026-08-26T07:02:24.000Z');
  assert.equal(record.historyComplete, false);
  assert.equal(record.historyGaps[0].startTime, '2026-03-02T12:00:00.000Z');
  assert.equal(record.historyGaps[0].endTime, '2026-08-26T07:02:24.000Z');
});

test('healthy Dune delivery advances query progress without duplicate Mimir RPC scans', async () => {
  const { runNodeVoteBackfill } = await import('../src/shared/node-votes.js');
  const { loadVoteScan } = await import('../src/shared/node-vote-acquisition.js');
  const client = scanClient();
  const duneStarts = [];
  let rpcCalls = 0;
  const options = failingPrimaryOptions({
    fetchDuneRows: async (start) => { duneStarts.push(start); return { rows: [], executionId: 'query-complete' }; },
    fetchRpcRows: async () => { rpcCalls++; throw new Error('RPC must not run for healthy Dune'); }
  });
  await runNodeVoteBackfill(client, options);
  const result = await runNodeVoteBackfill(client, { ...options, endTime: '2026-09-02T13:00:00Z' });
  assert.equal(rpcCalls, 0);
  assert.equal(duneStarts[1], '2026-08-19T12:00:00.000Z');
  assert.equal(await loadVoteScan(client, 'mimir'), null);
  assert.equal(result.mimir_coverage_verified, false);
  assert.equal(result.mimir_query_progress.queriedThrough, '2026-09-02T13:00:00.000Z');
});

test('rollout seeds non-certifying Dune query progress from a successful legacy Dune run', async () => {
  const { runNodeVoteBackfill } = await import('../src/shared/node-votes.js');
  const cache = acquisitionDatabase();
  const client = { query: async (sql, params) => sql.includes('from node_vote_sync_state')
    ? { rows: [{ end_time: '2026-09-01T12:00:00Z', start_time: '2026-03-01T12:00:00Z',
      stats_json: { source: 'dune', dune_error: '', start_time: '2026-08-18T12:00:00Z', dune_execution_id: 'legacy' } }] }
    : sql.includes('node_vote_sync_state') ? { rows: [] } : cache.query(sql, params) };
  let queriedFrom;
  const result = await runNodeVoteBackfill(client, failingPrimaryOptions({
    fetchDuneRows: async (start) => { queriedFrom = start; return { rows: [], executionId: 'new' }; }
  }));
  assert.equal(queriedFrom, '2026-08-18T12:00:00.000Z');
  assert.equal(result.mimir_coverage_verified, false);
});
