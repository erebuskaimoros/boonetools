import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshFinancialDayQueue } from '../src/shared/financials-day-detail.js';
import { createFinancialDaySource } from '../src/shared/financials-day-source.js';

const day = '2026-10-22';
const from = Date.parse(`${day}T00:00:00Z`) / 1000;
const now = (from + 12 * 3600) * 1000;

test('the collector starts a durable current-day roster without a visitor request', async () => {
  const statements = [];
  await refreshFinancialDayQueue({ query: async (sql, args) => {
    statements.push({ sql, args });
    return { rows: [] };
  } }, { now: () => now, maxRequests: 1, getJson: () => assert.fail('no selected job') });
  assert.ok(statements.some(({ sql }) => /insert into financials_day_details/i.test(sql)),
    'today must be scheduled by the collector, not the first visitor');
});

for (const [label, rosterDay] of [['today', day], ['the day that just closed', '2026-10-21']]) {
  test(`a background roster for ${label} advances after its visitor lease expires`, async () => {
    let requests = 0;
    const writes = [];
    const row = { day: rosterDay, background: true, state_json: null, payload_json: null,
      requested_at: new Date(now - 10 * 60_000).toISOString() };
    const client = { query: async (sql, args) => {
      if (/^select/i.test(sql.trim())) return { rows: [row] };
      if (/^update/i.test(sql.trim())) writes.push(args);
      return { rows: [] };
    } };
    await refreshFinancialDayQueue(client, { now: () => now, maxRequests: 1, getJson: async route => {
      requests++;
      assert.equal(route, '/health');
      return { inSync: true, lastAggregated: { timestamp: now / 1000 } };
    } });
    assert.equal(requests, 1, 'background maintenance must not depend on an open browser tab');
    assert.equal(writes.length, 1, 'the cursor is checkpointed before the next request');
  });
}

test('live pool rankings reuse an exact saved UTC-day prefix instead of refetching Midgard', async () => {
  const through = from + 12 * 3600;
  const route = `/history/swaps?interval=5min&from=${from}&count=144&pool=BTC.BTC`;
  const get = createFinancialDaySource({ client: { query: async () => ({ rows: [{
    asset: 'BTC.BTC', bucket_end: new Date(through * 1000).toISOString(),
    volume_rune_e8: '1234567890123456', volume_usd_e2: '987654321',
    observed_at: new Date(now).toISOString()
  }] }) }, getJson: () => assert.fail('an exact locally stored prefix must cost zero provider requests') });
  const result = await get(route);
  assert.deepEqual(result.intervals, [{ startTime: String(from), endTime: String(through),
    totalVolume: '1234567890123456', totalVolumeUSD: '987654321' }]);
});
