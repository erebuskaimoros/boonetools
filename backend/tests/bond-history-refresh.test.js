import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completeBondHistoryRefresh,
  enqueueBondHistoryRefresh,
  failBondHistoryRefresh
} from '../src/shared/bond-history-refresh-queue.js';
import { runBondHistoryRefreshQueue } from '../src/jobs/bond-history-refresh.js';

test('enqueueBondHistoryRefresh normalizes the queue identity', async () => {
  const calls = [];
  const row = {
    bond_address: 'thor1bond',
    scope: 'historical',
    status: 'pending'
  };
  const result = await enqueueBondHistoryRefresh({
    bondAddress: ' THOR1BOND ',
    scope: 'historical',
    includeBondTxs: true
  }, {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [row] };
    }
  });

  assert.equal(result, row);
  assert.deepEqual(calls[0].params, ['thor1bond', 'historical', true]);
  assert.match(calls[0].sql, /on conflict \(bond_address, scope\)/i);
  assert.match(calls[0].sql, /status in \('completed', 'failed'\) then 0/i);
  assert.match(calls[0].sql, /status = 'pending' then bond_history_refresh_queue\.available_at/i);
  assert.match(calls[0].sql, /excluded\.include_bond_txs\s+and not bond_history_refresh_queue\.include_bond_txs then now\(\)/i);
});

test('runBondHistoryRefreshQueue processes a claimed job under its address lock', async () => {
  const completed = [];
  let claimed = false;
  const result = await runBondHistoryRefreshQueue({
    batchSize: 2,
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      return {
        bond_address: 'thor1bond',
        scope: 'historical',
        include_bond_txs: true,
        attempts: 1,
        requested_at: '2026-07-17T12:00:00.000Z',
        started_at: '2026-07-17T12:00:01.000Z'
      };
    },
    withAdvisoryLock: async (key, callback) => {
      assert.equal(key, 'boonetools:bond-history:historical:thor1bond');
      return callback();
    },
    handleBondHistory: async (_request, url) => {
      assert.equal(url.searchParams.get('refresh'), 'sync');
      assert.equal(url.searchParams.get('include_historical'), 'true');
      return { status: 200, body: { total: 4, fetched: 2 } };
    },
    complete: async (job, response) => {
      completed.push({ job, response });
      return { ...job, status: 'completed' };
    },
    fail: async () => {
      throw new Error('Unexpected failure');
    }
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(completed[0].response, { status: 200, total: 4, fetched: 2 });
});

test('failBondHistoryRefresh schedules bounded exponential retry', async () => {
  const calls = [];
  const result = await failBondHistoryRefresh({
    bond_address: 'thor1bond',
    scope: 'current',
    attempts: 2,
    requested_at: '2026-07-17T12:00:00.000Z',
    started_at: '2026-07-17T12:00:01.000Z'
  }, new Error('temporary failure'), {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ status: 'pending', attempts: 2 }] };
    }
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.retry_delay_seconds, 60);
  assert.equal(calls[0].params[2], 'pending');
  assert.equal(calls[0].params[3], '60');
  assert.equal(calls[0].params[6], '2026-07-17T12:00:01.000Z');
  assert.match(calls[0].sql, /started_at = \$7::timestamptz/i);
});

test('completeBondHistoryRefresh requeues work requested after the active claim', async () => {
  const calls = [];
  const result = await completeBondHistoryRefresh({
    bond_address: 'thor1bond',
    scope: 'historical',
    requested_at: '2026-07-17T12:00:00.000Z',
    started_at: '2026-07-17T12:00:01.000Z'
  }, {}, {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ status: 'pending', attempts: 0 }] };
    }
  });

  assert.equal(result.status, 'pending');
  assert.match(calls[0].sql, /requested_at > \$3::timestamptz/i);
  assert.match(calls[0].sql, /started_at = \$4::timestamptz/i);
  assert.equal(calls[0].params[3], '2026-07-17T12:00:01.000Z');
});

test('runBondHistoryRefreshQueue retries stale partial success responses', async () => {
  let claimed = false;
  const failed = [];
  const result = await runBondHistoryRefreshQueue({
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      return {
        bond_address: 'thor1bond',
        scope: 'current',
        attempts: 1,
        requested_at: '2026-07-17T12:00:00.000Z',
        started_at: '2026-07-17T12:00:01.000Z'
      };
    },
    withAdvisoryLock: async (_key, callback) => callback(),
    handleBondHistory: async () => ({
      status: 200,
      body: { stale: true, warning: 'provider unavailable' }
    }),
    complete: async () => { throw new Error('partial response must not complete'); },
    fail: async (job, error) => {
      failed.push({ job, error });
      return { ...job, status: 'pending' };
    }
  });

  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.match(failed[0].error.message, /provider unavailable/);
});
