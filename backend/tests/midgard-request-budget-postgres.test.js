import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';
import pg from 'pg';
import { createMidgardRequestBudget } from '../src/lib/midgard-request-budget.js';

// Opt in ONLY with a disposable test database; never use DATABASE_URL here.
const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const limits = (minute, hour = minute, day = hour) => ({ minute, hour, day });

test('PostgreSQL migration atomically shares Midgard budget across connections and restarts',
  { skip: !databaseUrl }, async (t) => {
    assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
    const schema = `midgard_budget_test_${randomBytes(6).toString('hex')}`;
    const root = new pg.Client({ connectionString: databaseUrl });
    await root.connect();
    await root.query(`create schema ${schema}`);
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 16, options: `-c search_path=${schema}` });
    try {
      await pool.query(await readFile(new URL('../migrations/069_midgard_request_budget.sql', import.meta.url), 'utf8'));
      // Reapplying the migration is harmless and preserves accumulated counters.
      await pool.query(await readFile(new URL('../migrations/069_midgard_request_budget.sql', import.meta.url), 'utf8'));
      let clock = Date.parse('2099-01-01T00:00:10Z');
      const make = (total, bulk, client = pool) => createMidgardRequestBudget({ client, total, bulk, now: () => clock });
      const state = async (key) => (await pool.query('select * from midgard_request_budgets where provider_key = $1', [key])).rows[0];

      await t.test('concurrent processes cannot overspend and denied work leaves live capacity', async () => {
        const budget = make(limits(8, 12, 20), limits(5, 8, 10));
        const claims = await Promise.allSettled(Array.from({ length: 40 }, () => budget.claim({ providerKey: 'concurrency', budgetClass: 'bulk' })));
        assert.equal(claims.filter((entry) => entry.status === 'fulfilled').length, 5);
        const rejected = claims.filter((entry) => entry.status === 'rejected');
        assert.equal(rejected.length, 35);
        assert.ok(rejected.every((entry) => entry.reason.code === 'MIDGARD_BUDGET_DEFERRED' && entry.reason.budgetReason === 'bulk-minute'));
        for (let i = 0; i < 3; i++) await budget.claim({ providerKey: 'concurrency' });
        await assert.rejects(budget.claim({ providerKey: 'concurrency' }), { budgetReason: 'total-minute' });
        const row = await state('concurrency');
        assert.equal(Number(row.spent_total), 8);
        assert.equal(Number(row.bulk_spent_total), 5);
        assert.equal(Number(row.deferred_total), 36);
        assert.equal(Number(row.bulk_deferred_total), 35);
        assert.equal(Number(row.day_spent), 8);
      });

      await t.test('a fresh process sees the same persistent quota', async () => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
          import pg from 'pg';
          const client = new pg.Client({ connectionString: process.env.ACQUISITION_TEST_DATABASE_URL,
            options: '-c search_path=' + process.env.MIDGARD_TEST_SCHEMA });
          await client.connect();
          const result = await client.query('select * from claim_midgard_request_budget($1,$2,$3,$4,$5)',
            ['concurrency', false, [8,12,20], [5,8,10], '2099-01-01T00:00:10Z']);
          process.stdout.write(JSON.stringify(result.rows[0]));
          await client.end();
        `], { cwd: new URL('../', import.meta.url), env: { ...process.env, MIDGARD_TEST_SCHEMA: schema }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 0, stderr);
        assert.equal(JSON.parse(stdout).allowed, false);
        assert.equal(JSON.parse(stdout).reason, 'total-minute');
      });

      await t.test('production default transport uses the durable singleton before fetch', async () => {
        const scopedUrl = new URL(databaseUrl);
        scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
          const { requestFromProviders } = await import('./src/lib/provider-client.js');
          const { closePool } = await import('./src/db/pool.js');
          let calls = 0, denied = 0;
          for (let i = 0; i < 31; i++) {
            try { await requestFromProviders({
              bases: ['https://gateway.liquify.com/chain/thorchain_midgard/v2'],
              path: '/actions?limit=50', providerPool: false,
              fetchImpl: async () => { calls++; return new Response('{"actions":[]}',
                { headers: { 'content-type': 'application/json' } }); }
            }); } catch (error) {
              if (error.code !== 'MIDGARD_BUDGET_DEFERRED' || error.budgetReason !== 'bulk-minute') throw error;
              denied++;
            }
          }
          const { fetchRapidSwapRows, fetchRapidSwapSourceStatus } = await import('./src/shared/rapid-swaps.js');
          let rapidFetches = 0, rapidDenied = 0;
          globalThis.fetch = async () => { rapidFetches++; throw new Error('Rapid budget bypass'); };
          try { await fetchRapidSwapRows({ priceIndex: {}, maxPages: 1 }); }
          catch (error) {
            if (error.code !== 'MIDGARD_BUDGET_DEFERRED') throw error;
            rapidDenied++;
          }
          await fetchRapidSwapSourceStatus({ coreSnapshot: { mimir: {}, inbound_addresses: [], lastblock: [] } });
          process.stdout.write(JSON.stringify({ calls, denied, rapidFetches, rapidDenied }));
          await closePool();
        `], { cwd: new URL('../', import.meta.url), env: { ...process.env,
          DATABASE_URL: scopedUrl.toString(), NODE_ENV: 'production',
          BOONETOOLS_ENV_FILE: '/nonexistent/midgard-budget-test.env', MIDGARD_REQUEST_BUDGET_ENABLED: 'true',
          MIDGARD_REQUEST_BUDGET_TOTAL_MINUTE: '60', MIDGARD_REQUEST_BUDGET_TOTAL_HOUR: '2000', MIDGARD_REQUEST_BUDGET_TOTAL_DAY: '20000',
          MIDGARD_REQUEST_BUDGET_BULK_MINUTE: '30', MIDGARD_REQUEST_BUDGET_BULK_HOUR: '1000', MIDGARD_REQUEST_BUDGET_BULK_DAY: '5000'
        }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 0, stderr);
        assert.deepEqual(JSON.parse(stdout), { calls: 30, denied: 1, rapidFetches: 0, rapidDenied: 1 });
      });

      await t.test('minute, hour and UTC day boundaries roll independently and return the latest blocking reset', async () => {
        const budget = make(limits(2, 3, 4), limits(1, 2, 3));
        clock = Date.parse('2099-01-01T00:00:10Z');
        await budget.claim({ providerKey: 'rollover', budgetClass: 'bulk' });
        await assert.rejects(budget.claim({ providerKey: 'rollover', budgetClass: 'bulk' }), {
          budgetReason: 'bulk-minute', retryAt: '2099-01-01T00:01:00.000Z'
        });
        await budget.claim({ providerKey: 'rollover' });
        clock += 60_000;
        await budget.claim({ providerKey: 'rollover', budgetClass: 'bulk' });
        await assert.rejects(budget.claim({ providerKey: 'rollover' }), {
          budgetReason: 'total-hour', retryAt: '2099-01-01T01:00:00.000Z'
        });
        clock = Date.parse('2099-01-01T01:00:10Z');
        await budget.claim({ providerKey: 'rollover', budgetClass: 'bulk' });
        await assert.rejects(budget.claim({ providerKey: 'rollover' }), {
          budgetReason: 'total-day', retryAt: '2099-01-02T00:00:00.000Z'
        });
        clock = Date.parse('2099-01-02T00:00:00Z');
        await budget.claim({ providerKey: 'rollover', budgetClass: 'bulk' });
        const row = await state('rollover');
        assert.equal(Number(row.day_spent), 1);
        assert.equal(Number(row.bulk_day_spent), 1);
        assert.equal(Number(row.spent_total), 5);
        assert.equal(Number(row.deferred_total), 3);
      });

      await t.test('bulk day exhaustion cannot consume the reserved live allowance', async () => {
        const budget = make(limits(20), limits(10, 10, 2));
        for (let i = 0; i < 2; i++) await budget.claim({ providerKey: 'reserve', budgetClass: 'bulk' });
        await assert.rejects(budget.claim({ providerKey: 'reserve', budgetClass: 'bulk' }), { budgetReason: 'bulk-day' });
        await budget.claim({ providerKey: 'reserve' });
        assert.equal(Number((await state('reserve')).day_spent), 3);
      });

      await t.test('refunds are idempotent and do not alter a newer window', async () => {
        const budget = make(limits(10), limits(5));
        clock = Date.parse('2099-01-04T00:00:10Z');
        const prior = await budget.claim({ providerKey: 'refund', budgetClass: 'bulk' });
        clock += 60_000;
        await budget.claim({ providerKey: 'refund', budgetClass: 'bulk' });
        await prior.cancel();
        await prior.cancel();
        const row = await state('refund');
        assert.equal(Number(row.minute_spent), 1);
        assert.equal(Number(row.hour_spent), 1);
        assert.equal(Number(row.day_spent), 1);
        assert.equal(Number(row.spent_total), 1);
      });

      await t.test('clock regressions do not reopen an exhausted window', async () => {
        const budget = make(limits(1), limits(1));
        clock = Date.parse('2099-01-05T00:01:10Z');
        await budget.claim({ providerKey: 'clock-regression' });
        clock -= 60_000;
        await assert.rejects(budget.claim({ providerKey: 'clock-regression' }), { budgetReason: 'total-day' });
      });

      await t.test('an old refund cannot rewind the monotonic window guard', async () => {
        const budget = make(limits(1, 10, 20), limits(1, 10, 20));
        clock = Date.parse('2099-01-06T00:00:10Z');
        const first = await budget.claim({ providerKey: 'refund-clock' });
        clock += 60_000;
        await budget.claim({ providerKey: 'refund-clock' });
        await first.cancel();
        clock -= 60_000;
        await assert.rejects(budget.claim({ providerKey: 'refund-clock' }), { budgetReason: 'total-minute' });
        const row = await state('refund-clock');
        assert.equal(row.minute_start.toISOString(), '2099-01-06T00:01:00.000Z');
        assert.equal(Number(row.minute_spent), 1);
      });
    } finally {
      await pool.end();
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
