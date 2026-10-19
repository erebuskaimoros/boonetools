import assert from 'node:assert/strict';
import test from 'node:test';
import { financialDayPollDelay } from '../src/lib/financials/day-poll.js';

test('completed snapshots stop polling even when excluded pending swaps remain', () => {
  assert.equal(financialDayPollDelay({ loading: false, partial: false, pendingSwaps: 82, finalized: false }), null);
});

test('budget deferrals slow status polling while retaining an active viewer lease', () => {
  const now = Date.parse('2026-10-19T02:00:00Z');
  const deferred = { loading: true, deferred: true, error: 'Request budget reached', retryAt: new Date(now + 3600_000).toISOString() };
  assert.equal(financialDayPollDelay(deferred, '', now), 60_000);
  assert.equal(financialDayPollDelay({ ...deferred, retryAt: new Date(now + 12_000).toISOString() }, '', now), 12_000);
  assert.equal(financialDayPollDelay({ ...deferred, retryAt: new Date(now - 1000).toISOString() }, '', now), 5000);
  assert.equal(financialDayPollDelay({ ...deferred, retryAt: 'bad timestamp' }, '', now), 60_000);
});

test('loading, incremental updates and ordinary errors have bounded independent cadences', () => {
  assert.equal(financialDayPollDelay({ loading: true }), 5000);
  assert.equal(financialDayPollDelay({ refreshing: true, partial: true }), 5000);
  assert.equal(financialDayPollDelay({ partial: true }), 60_000);
  assert.equal(financialDayPollDelay({}, 'Connection unavailable'), 30_000);
  assert.equal(financialDayPollDelay({ error: 'Source unavailable' }), 30_000);
});
