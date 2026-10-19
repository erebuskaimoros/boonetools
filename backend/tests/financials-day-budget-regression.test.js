import assert from 'node:assert/strict';
import test from 'node:test';
import { readFinancialDay, refreshFinancialDayQueue } from '../src/shared/financials-day-detail.js';

const day = '2026-10-16';
const now = Date.parse('2026-10-19T01:00:00Z');
const from = Date.parse(`${day}T00:00:00Z`) / 1000;
const complete = {
  day, through: '2026-10-17T00:00:00.000Z', observedAt: '2026-10-18T10:33:00.000Z',
  partial: false, finalized: false, pendingSwaps: 82, unpricedSwaps: 0,
  swaps: [], pools: []
};

test('a completed day with pending swaps stays cached instead of advertising another full rescan', async () => {
  const result = await readFinancialDay(day, { now: () => now, client: { query: async () => ({ rows: [{
    payload_json: complete, phase: 'done', available_at: new Date(now - 1000).toISOString()
  }] }) } });
  assert.equal(result.loading, false);
  assert.equal(result.refreshing, false);
  assert.equal(result.pendingSwaps, 82, 'freezing a snapshot must not claim excluded swaps were resolved');
  assert.equal(result.finalized, false, 'acquisition completion is not financial finality');
});

test('the worker must not restart a cached closed day even when pending swaps prevent finality', async () => {
  let requests = 0;
  const client = { query: async sql => sql.startsWith('select') ? { rows: [{
    day, state_json: null, payload_json: complete, requested_at: new Date(now).toISOString()
  }] } : { rows: [] } };
  await refreshFinancialDayQueue(client, { now: () => now, maxRequests: 1,
    getJson: async () => { requests++; return { inSync: true, lastAggregated: { timestamp: from + 86400 } }; }
  });
  assert.equal(requests, 0, 'a completed historical day must cost zero further upstream requests');
});

test('abandoned unfinished day scans retain their checkpoint but stop spending requests', async () => {
  let requests = 0;
  const state = { day, from, to: from + 86400, phase: 'health', pages: 0 };
  const client = { query: async sql => sql.startsWith('select') ? { rows: [{
    day, state_json: state, payload_json: null, requested_at: new Date(now - 10 * 60_000).toISOString()
  }] } : { rows: [] } };
  await refreshFinancialDayQueue(client, { now: () => now, maxRequests: 1,
    getJson: async () => { requests++; return { inSync: true, lastAggregated: { timestamp: from + 86400 } }; }
  });
  assert.equal(requests, 0, 'a ten-minute-old visitor request must not keep scanning for seven days');
  assert.equal(state.phase, 'health', 'pausing must preserve resumable state');
});
