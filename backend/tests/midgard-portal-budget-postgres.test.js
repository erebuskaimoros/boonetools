import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { createMidgardRequestBudget } from '../src/lib/midgard-request-budget.js';

// Opt in ONLY with a disposable test database, never DATABASE_URL.
const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const total = { minute: 60, hour: 2000, day: 20000 };
const bulk = { minute: 30, hour: 1000, day: 5000 };
const portal = { total: { ...total, minute: 180 }, bulk: { ...bulk, minute: 60 }, minIntervalMs: 200 };
const wide = [180, 2000, 20000], wideBulk = [60, 1000, 5000];

test('PostgreSQL Portal pacing shares durable slots without replacing quota accounting',
  { skip: !databaseUrl }, async (t) => {
    assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
    const schema = `midgard_portal_test_${randomBytes(6).toString('hex')}`;
    const root = new pg.Client({ connectionString: databaseUrl });
    await root.connect();
    await root.query(`create schema ${schema}`);
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 16, options: `-c search_path=${schema}` });
    const migration = await readFile(new URL('../migrations/070_midgard_request_pacing.sql', import.meta.url), 'utf8');
    const state = async (key) => (await pool.query('select * from midgard_request_budgets where provider_key = $1', [key])).rows[0];
    const claim = async (key, at, { isBulk = false, totals = wide, bulks = wideBulk, interval = 200, client = pool } = {}) =>
      (await client.query('select * from claim_midgard_request_budget_paced($1,$2,$3::integer[],$4::integer[],$5::timestamptz,$6)',
        [key, isBulk, totals, bulks, at, interval])).rows[0];
    const oldClaim = async (key, at, { totals = [60, 2000, 20000], bulks = [30, 1000, 5000] } = {}) =>
      (await pool.query('select * from claim_midgard_request_budget($1,false,$2::integer[],$3::integer[],$4::timestamptz)',
        [key, totals, bulks, at])).rows[0];
    try {
      await pool.query(await readFile(new URL('../migrations/069_midgard_request_budget.sql', import.meta.url), 'utf8'));
      await oldClaim('upgrade', '2099-01-01T00:00:10Z');
      await oldClaim('upgrade', '2099-01-01T00:00:10Z');
      const beforeUpgrade = await state('upgrade');
      await pool.query(migration);

      await t.test('migration preserves pre-existing provider identity, counters and original public limit', async () => {
        assert.deepEqual(await state('upgrade'), { ...beforeUpgrade, next_request_at: null });
        for (let i = 2; i < 60; i++) assert.equal((await oldClaim('upgrade', '2099-01-01T00:00:10Z')).allowed, true);
        const denied = await oldClaim('upgrade', '2099-01-01T00:00:10Z');
        assert.equal(denied.allowed, false);
        assert.equal(denied.reason, 'total-minute');
        assert.equal(denied.retry_at.toISOString(), '2099-01-01T00:01:00.000Z');
        assert.equal((await claim('upgrade', '2099-01-01T00:00:10Z')).allowed, true);
        assert.equal(Number((await state('upgrade')).minute_spent), 61);
        assert.equal(Number((await state('upgrade')).day_spent), 61);
      });

      await t.test('concurrent connections allow only one start per 200ms and pacing spends nothing', async () => {
        const clients = await Promise.all(Array.from({ length: 12 }, () => pool.connect()));
        try {
          const burst = async (at) => Promise.all(clients.map((client) => claim('concurrency', at, { client, isBulk: true })));
          const first = await burst('2099-01-02T00:00:10.000Z');
          assert.equal(first.filter((row) => row.allowed).length, 1);
          assert.ok(first.filter((row) => !row.allowed).every((row) => row.reason === 'pacing'
            && row.retry_at.toISOString() === '2099-01-02T00:00:10.200Z' && row.reserved_at === null));
          const beforeDenied = await state('concurrency');
          assert.ok((await burst('2099-01-02T00:00:10.199Z')).every((row) => !row.allowed));
          assert.deepEqual(await state('concurrency'), beforeDenied);
          assert.equal((await burst('2099-01-02T00:00:10.200Z')).filter((row) => row.allowed).length, 1);
          const row = await state('concurrency');
          assert.equal(Number(row.spent_total), 2);
          assert.equal(Number(row.bulk_spent_total), 2);
          assert.equal(Number(row.day_spent), 2);
          assert.equal(Number(row.deferred_total), 0);
        } finally { clients.forEach((client) => client.release()); }
      });

      await t.test('real database-clock admissions are spaced across independent connections', async () => {
        const starts = [];
        await Promise.all(Array.from({ length: 8 }, async () => {
          for (let attempt = 0; attempt < 30; attempt++) {
            const row = await claim('real-clock', null);
            if (row.allowed) { starts.push(row.reserved_at.getTime()); return; }
            assert.equal(row.reason, 'pacing');
            await delay(Math.max(1, row.retry_at.getTime() - Date.now()));
          }
          assert.fail('real-clock pacing did not admit a waiting connection');
        }));
        starts.sort((a, b) => a - b);
        assert.equal(starts.length, 8);
        assert.ok(starts.slice(1).every((value, index) => value - starts[index] >= 200));
        assert.equal(Number((await state('real-clock')).spent_total), 8);
      });

      await t.test('production admission samples its clock after waiting for the shared row lock', async () => {
        await claim('lock-clock', null);
        const locker = await pool.connect();
        const contender = await pool.connect();
        let pending;
        try {
          await locker.query('begin');
          await locker.query('select * from midgard_request_budgets where provider_key = $1 for update', ['lock-clock']);
          pending = claim('lock-clock', null, { client: contender });
          await delay(250);
          const { rows: [{ released_at: releasedAt }] } = await locker.query('select clock_timestamp() as released_at');
          await locker.query('commit');
          const admitted = await pending;
          assert.equal(admitted.allowed, true, 'a pre-lock clock would incorrectly retain the expired pacing delay');
          assert.ok(admitted.reserved_at.getTime() >= releasedAt.getTime());
          assert.equal(Number((await state('lock-clock')).spent_total), 2);
        } finally {
          await locker.query('rollback');
          await pending?.catch(() => {});
          locker.release();
          contender.release();
        }
      });

      await t.test('spacing holds across second boundaries instead of granting a new burst', async () => {
        const first = await claim('second-boundary', '2099-01-03T00:00:00.900Z');
        assert.equal(first.allowed, true);
        const denied = await claim('second-boundary', '2099-01-03T00:00:01.000Z');
        assert.equal(denied.reason, 'pacing');
        assert.equal(denied.retry_at.toISOString(), '2099-01-03T00:00:01.100Z');
        assert.equal((await claim('second-boundary', '2099-01-03T00:00:01.100Z')).allowed, true);
      });

      await t.test('minute, hour and day caps retain latest-reset reasons even while pacing', async () => {
        const options = { totals: [2, 3, 4], bulks: [1, 2, 3] };
        assert.equal((await claim('caps', '2099-01-04T00:00:10Z', { ...options, isBulk: true })).allowed, true);
        let denied = await claim('caps', '2099-01-04T00:00:10.001Z', { ...options, isBulk: true });
        assert.equal(denied.reason, 'bulk-minute');
        assert.equal(denied.retry_at.toISOString(), '2099-01-04T00:01:00.000Z');
        assert.equal((await claim('caps', '2099-01-04T00:00:10.200Z', options)).allowed, true);
        denied = await claim('caps', '2099-01-04T00:00:10.201Z', options);
        assert.equal(denied.reason, 'total-minute');
        assert.equal((await claim('caps', '2099-01-04T00:01:00Z', { ...options, isBulk: true })).allowed, true);
        denied = await claim('caps', '2099-01-04T00:01:00.001Z', options);
        assert.equal(denied.reason, 'total-hour');
        assert.equal(denied.retry_at.toISOString(), '2099-01-04T01:00:00.000Z');
        assert.equal((await claim('caps', '2099-01-04T01:00:00Z', { ...options, isBulk: true })).allowed, true);
        const beforeDenied = await state('caps');
        denied = await claim('caps', '2099-01-04T01:00:00.001Z', options);
        assert.equal(denied.reason, 'total-day');
        assert.equal(denied.retry_at.toISOString(), '2099-01-05T00:00:00.000Z');
        const afterDenied = await state('caps');
        assert.equal(Number(afterDenied.spent_total), 4);
        assert.equal(Number(afterDenied.day_spent), 4);
        assert.equal(Number(afterDenied.deferred_total), 4);
        assert.deepEqual(afterDenied.next_request_at, beforeDenied.next_request_at);
        assert.equal((await claim('caps', '2099-01-05T00:00:00Z', { ...options, isBulk: true })).allowed, true);
        assert.equal(Number((await state('caps')).day_spent), 1);
      });

      await t.test('bulk daily exhaustion preserves live allowance and does not advance slots', async () => {
        const options = { totals: [20, 30, 40], bulks: [10, 10, 2], isBulk: true };
        await claim('bulk-day', '2099-01-05T00:00:10Z', options);
        await claim('bulk-day', '2099-01-05T00:00:10.200Z', options);
        const before = await state('bulk-day');
        const denied = await claim('bulk-day', '2099-01-05T00:00:10.201Z', options);
        assert.equal(denied.reason, 'bulk-day');
        assert.equal(denied.retry_at.toISOString(), '2099-01-06T00:00:00.000Z');
        assert.deepEqual((await state('bulk-day')).next_request_at, before.next_request_at);
        assert.equal((await claim('bulk-day', '2099-01-05T00:00:10.400Z', { ...options, isBulk: false })).allowed, true);
        assert.equal(Number((await state('bulk-day')).day_spent), 3);
      });

      await t.test('reapplying migration and restarting a process preserve the pending slot', async () => {
        await claim('restart', '2099-01-06T00:00:10Z');
        const before = await state('restart');
        await pool.query(migration);
        await pool.query(migration);
        assert.deepEqual(await state('restart'), before);
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
          import pg from 'pg';
          const client = new pg.Client({ connectionString: process.env.ACQUISITION_TEST_DATABASE_URL,
            options: '-c search_path=' + process.env.MIDGARD_TEST_SCHEMA });
          await client.connect();
          const result = await client.query('select * from claim_midgard_request_budget_paced($1,$2,$3,$4,$5,$6)',
            ['restart', false, [180,2000,20000], [60,1000,5000], '2099-01-06T00:00:10.100Z', 200]);
          process.stdout.write(JSON.stringify(result.rows[0]));
          await client.end();
        `], { cwd: new URL('../', import.meta.url), env: { ...process.env, MIDGARD_TEST_SCHEMA: schema }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 0, stderr);
        assert.deepEqual(JSON.parse(stdout), { allowed: false, retry_at: '2099-01-06T00:00:10.200Z', reason: 'pacing', reserved_at: null });
        assert.deepEqual(await state('restart'), before);
      });

      await t.test('canceled admission refunds once without rewinding the shared spacing clock', async () => {
        const instant = Date.parse('2099-01-07T00:00:10Z');
        const budget = createMidgardRequestBudget({ client: pool, total, bulk, portal, now: () => instant });
        const receipt = await budget.claim({ providerKey: 'refund', budgetProfile: 'liquify-portal', budgetClass: 'bulk' });
        const before = await state('refund');
        await receipt.cancel();
        await receipt.cancel();
        const refunded = await state('refund');
        assert.equal(Number(refunded.spent_total), 0);
        assert.equal(Number(refunded.bulk_spent_total), 0);
        assert.equal(Number(refunded.day_spent), 0);
        assert.deepEqual(refunded.next_request_at, before.next_request_at);
        assert.equal((await claim('refund', '2099-01-07T00:00:10.100Z')).reason, 'pacing');
        assert.equal((await claim('refund', '2099-01-07T00:00:10.200Z')).allowed, true);
        assert.equal(Number((await state('refund')).spent_total), 1);
      });

      await t.test('backwards clocks cannot reopen a slot or an older exhausted window', async () => {
        await claim('clock-regression', '2099-01-08T00:01:10Z');
        const before = await state('clock-regression');
        const denied = await claim('clock-regression', '2099-01-08T00:00:10Z');
        assert.equal(denied.reason, 'pacing');
        assert.equal(denied.retry_at.toISOString(), '2099-01-08T00:01:10.200Z');
        assert.deepEqual(await state('clock-regression'), before);
        const capped = { totals: [1, 10, 20], bulks: [1, 10, 20] };
        await claim('clock-capped', '2099-01-08T00:01:10Z', capped);
        const capDenied = await claim('clock-capped', '2099-01-08T00:00:10Z', capped);
        assert.equal(capDenied.reason, 'total-minute');
        assert.equal(capDenied.retry_at.toISOString(), '2099-01-08T00:02:00.000Z');
        assert.equal((await state('clock-capped')).minute_start.toISOString(), '2099-01-08T00:01:00.000Z');
      });

      await t.test('invalid intervals and limits fail closed without creating a provider row', async () => {
        for (const interval of [null, 0, -1, 60001]) {
          await assert.rejects(claim('invalid', null, { interval }), /pacing interval/);
        }
        await assert.rejects(claim('invalid', null, { totals: [1, 2] }), /minute, hour and day/);
        await assert.rejects(claim('invalid', null, { bulks: [181, 1000, 5000] }), /Invalid Midgard budget limits/);
        assert.equal(await state('invalid'), undefined);
      });
    } finally {
      await pool.end();
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
