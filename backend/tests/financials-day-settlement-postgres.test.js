import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { refreshFinancialDayQueue, readFinancialDay } from '../src/shared/financials-day-detail.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const now = Date.parse('2026-10-24T12:00:00Z');
const today = '2026-10-24';
const iso = value => new Date(value).toISOString();
const snapshot = (day, ids = ['PENDING']) => ({ day, through: iso(Date.parse(`${day}T00:00:00Z`) + 86400_000),
  observedAt: iso(now - 3600_000), pendingSwaps: ids.length, unpricedSwaps: 0,
  excludedSwaps: ids.map(txId => ({ txId, kind: 'pending' })), exclusionsIncomplete: false,
  partial: false, finalized: false, swaps: [], pools: [{ asset: 'BTC.BTC', volumeUsd: 42, volumeRune: 43 }] });

async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `financials_settlement_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query("set local time zone 'Pacific/Honolulu'");
    for (const migration of ['068_financials_day_details.sql', '072_financials_background_rosters.sql']) {
      await client.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    await run(client);
  } finally { await client.query('rollback'); await client.end(); }
}

const postgres = { skip: !databaseUrl };

test('Postgres adopts closed retained IDs without reviving count-only rows or resetting durable cooldowns', postgres, async () => {
  await withDatabase(async client => {
    await client.query(`insert into financials_day_details(day, background, available_at) values ($1, true, $2)`, [today, iso(now + 86400_000)]);
    const deferredDay = '2026-10-20', dueDay = '2026-10-21', countOnlyDay = '2026-10-19', noWorkDay = '2026-10-18';
    const countOnly = { ...snapshot(countOnlyDay), excludedSwaps: undefined };
    for (const [day, payload, available, error] of [
      [deferredDay, snapshot(deferredDay, ['DEFERRED']), now + 3600_000, 'Provider cooling down'],
      [dueDay, snapshot(dueDay, ['DUE']), now - 1, null],
      [countOnlyDay, countOnly, now - 1, null],
      [noWorkDay, snapshot(noWorkDay, []), now - 1, null]
    ]) {
      await client.query(`insert into financials_day_details(day, payload_json, requested_at, available_at, last_error)
        values ($1, $2, $3, $4, $5)`, [day, payload, iso(now - 10 * 86400_000), iso(available), error]);
    }
    const routes = [];
    await refreshFinancialDayQueue(client, { now: () => now, maxRequests: 10, getJson: async route => {
      routes.push(route); return { actions: [] };
    } });
    assert.equal(routes.length, 1);
    assert.equal(new URL(routes[0], 'https://example.invalid').searchParams.get('txid'), 'DUE');
    const saved = (await client.query(`select day::text, background, available_at, state_json, payload_json from financials_day_details order by day`)).rows;
    assert.equal(saved.find(row => row.day === deferredDay).background, true);
    assert.equal(saved.find(row => row.day === deferredDay).available_at.toISOString(), iso(now + 3600_000));
    assert.equal(saved.find(row => row.day === deferredDay).state_json, null);
    assert.equal(saved.find(row => row.day === countOnlyDay).background, false);
    assert.equal(saved.find(row => row.day === noWorkDay).background, false);
    assert.equal(saved.find(row => row.day === dueDay).payload_json.settlement.nextCheckAt, iso(now + 3600_000));
    await refreshFinancialDayQueue(client, { now: () => now + 1000, getJson: () => assert.fail('backoff must be honored by SQL eligibility') });
    const view = await readFinancialDay(deferredDay, { client, now: () => now });
    assert.equal(view.settlement.status, 'pending');
    assert.equal(view.deferred, true);
    assert.equal(view.refreshing, false);
  });
});

test('Postgres settlement checkpoint survives a failed ID and retries only that ID at the provider horizon', postgres, async () => {
  await withDatabase(async client => {
    const day = '2026-10-22', payload = snapshot(day, ['A', 'B', 'C']);
    await client.query(`insert into financials_day_details(day, background, available_at) values ($1, true, $2)`, [today, iso(now + 86400_000)]);
    await client.query(`insert into financials_day_details(day, payload_json, available_at, requested_at) values ($1, $2, $3, $4)`,
      [day, payload, iso(now), iso(now - 10 * 86400_000)]);
    const routes = [];
    const options = { now: () => now, maxRequests: 1, getJson: async route => { routes.push(route); return { actions: [] }; } };
    await refreshFinancialDayQueue(client, options);
    const first = (await client.query('select state_json from financials_day_details where day = $1', [day])).rows[0].state_json;
    assert.equal(first.settlement.cursor, 1);
    assert.equal(first.settlement.checkedAt, undefined, 'only whole passes have check timestamps');
    const retryAt = iso(now + 4 * 3600_000);
    await refreshFinancialDayQueue(client, { ...options, getJson: async route => {
      routes.push(route); throw Object.assign(new Error('Budget deferred'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt });
    } });
    assert.deepEqual((await client.query('select state_json from financials_day_details where day = $1', [day])).rows[0].state_json, first);
    await refreshFinancialDayQueue(client, { ...options, now: () => now + 3600_000, getJson: () => assert.fail('provider retry must remain authoritative') });
    await refreshFinancialDayQueue(client, { ...options, now: () => Date.parse(retryAt) });
    assert.deepEqual(routes.map(route => new URL(route, 'https://example.invalid').searchParams.get('txid')), ['A', 'B', 'B']);
    const resumed = (await client.query('select state_json, payload_json from financials_day_details where day = $1', [day])).rows[0];
    assert.equal(resumed.state_json.settlement.cursor, 2);
    assert.deepEqual(resumed.payload_json.pools, payload.pools);
    assert.equal(resumed.payload_json.through, payload.through);
  });
});

test('Postgres current, unfinished, visitor and closed settlement lanes share one-request turns fairly', postgres, async () => {
  await withDatabase(async client => {
    const closed = '2026-10-21';
    for (const [day, background, payload] of [[today, true, null], ['2026-10-23', true, null], ['2026-10-20', false, null],
      [closed, false, snapshot(closed, ['PENDING'])]]) {
      await client.query(`insert into financials_day_details(day, background, payload_json, available_at, requested_at)
        values ($1, $2, $3, $4, $4)`, [day, background, payload, iso(now)]);
    }
    let clock = now;
    const routes = [];
    for (let index = 0; index < 4; index++) {
      await refreshFinancialDayQueue(client, { now: () => clock, maxRequests: 1, getJson: async route => {
        routes.push(route);
        return route === '/health' ? { inSync: true, lastAggregated: { timestamp: now / 1000 } } : { actions: [] };
      } });
      clock += 1000;
    }
    const rows = (await client.query('select day::text, state_json, last_worked_at from financials_day_details')).rows;
    assert.equal(rows.length, 4);
    assert.ok(rows.every(row => row.last_worked_at), 'every lane receives one turn before any gets a second');
    assert.equal(routes.filter(route => route === '/health').length, 3);
    assert.equal(routes.filter(route => route.includes('txid=PENDING')).length, 1);
  });
});

test('Postgres targeted settlement batches honor the ten-step cap and never erase a saved partial-pass cursor', postgres, async () => {
  await withDatabase(async client => {
    const day = '2026-10-22', ids = Array.from({ length: 25 }, (_, index) => `ID-${index}`);
    await client.query(`insert into financials_day_details(day, background, available_at) values ($1, true, $2)`, [today, iso(now + 86400_000)]);
    await client.query(`insert into financials_day_details(day, payload_json, available_at, requested_at) values ($1, $2, $3, $4)`,
      [day, snapshot(day, ids), iso(now), iso(now - 10 * 86400_000)]);
    const lookedUp = [];
    const options = { now: () => now, maxRequests: 100, getJson: async route => {
      lookedUp.push(new URL(route, 'https://example.invalid').searchParams.get('txid')); return { actions: [] };
    } };
    await refreshFinancialDayQueue(client, options);
    assert.deepEqual(lookedUp, ids.slice(0, 10));
    assert.equal((await client.query('select state_json from financials_day_details where day = $1', [day])).rows[0].state_json.settlement.cursor, 10);
    await refreshFinancialDayQueue(client, options);
    assert.deepEqual(lookedUp, ids.slice(0, 20));
  });
});
