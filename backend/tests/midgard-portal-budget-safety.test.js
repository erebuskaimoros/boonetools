import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createMidgardRequestBudget } from '../src/lib/midgard-request-budget.js';

const total = { minute: 60, hour: 2000, day: 20000 };
const bulk = { minute: 30, hour: 1000, day: 5000 };
const portal = { total: { ...total, minute: 180 }, bulk: { ...bulk, minute: 60 }, minIntervalMs: 200 };
const claim = { providerKey: 'fixture', budgetProfile: 'liquify-portal' };
const instant = Date.parse('2099-01-01T00:00:00.100Z');

test('public admission keeps the legacy SQL and limits even when Portal pacing is configured', async () => {
  const budget = createMidgardRequestBudget({ total, bulk, portal,
    client: { async query(sql, values) {
      assert.doesNotMatch(sql, /_paced/);
      assert.deepEqual(values.slice(2, 4), [[60, 2000, 20000], [30, 1000, 5000]]);
      assert.equal(values.length, 5);
      return { rows: [{ allowed: true, reserved_at: new Date(instant) }] };
    } }
  });
  await budget.claim({ providerKey: 'public', budgetProfile: 'default' });
});

test('pacing honors millisecond precision for PostgreSQL Date timestamps', async () => {
  let current = instant, attempts = 0;
  const budget = createMidgardRequestBudget({ total, bulk, portal, now: () => current,
    client: { async query(sql, values) {
      assert.equal(values[4], new Date(current).toISOString(), 'every retry samples current time');
      return { rows: [++attempts === 1
        ? { allowed: false, reason: 'pacing', retry_at: new Date(current + 200) }
        : { allowed: true, reserved_at: new Date(current) }] };
    } },
    wait: async (ms) => { assert.equal(ms, 200); current += ms; }
  });
  await budget.claim(claim);
  assert.equal(attempts, 2);
});

test('repeated pacing with a frozen clock and no AbortSignal remains bounded', async () => {
  let attempts = 0, waited = 0;
  const budget = createMidgardRequestBudget({ total, bulk, portal, now: () => instant,
    client: { async query() {
      attempts++;
      return { rows: [{ allowed: false, reason: 'pacing', retry_at: new Date(instant + 200) }] };
    } }, wait: async (ms) => { waited += ms; }
  });
  await assert.rejects(budget.claim(claim), { budgetReason: 'pacing', skipProvider: true });
  assert.ok(attempts <= 26);
  assert.ok(waited <= 5000);
});

test('past pacing timestamps cannot spin indefinitely or spend quota', async () => {
  let attempts = 0;
  const budget = createMidgardRequestBudget({ total, bulk, portal, now: () => instant,
    client: { async query() {
      attempts++;
      return { rows: [{ allowed: false, reason: 'pacing', retry_at: new Date(instant - 200) }] };
    } }, wait: async (ms) => { assert.ok(ms >= 1); }
  });
  await assert.rejects(budget.claim(claim), { budgetReason: 'pacing' });
  assert.ok(attempts <= 51);
});

test('clock regression beyond the pacing wait bound defers immediately', async () => {
  const budget = createMidgardRequestBudget({ total, bulk, portal, now: () => instant,
    client: { async query() {
      return { rows: [{ allowed: false, reason: 'pacing', retry_at: new Date(instant + 60_000) }] };
    } }, wait: async () => assert.fail('a far-future timestamp must not sleep')
  });
  await assert.rejects(budget.claim(claim), { budgetReason: 'pacing' });
});

test('malformed pacing timestamps fail closed', async () => {
  for (const retry_at of [undefined, null, 'invalid', new Date(NaN)]) {
    const budget = createMidgardRequestBudget({ total, bulk, portal, now: () => instant,
      client: { async query() { return { rows: [{ allowed: false, reason: 'pacing', retry_at }] }; } },
      wait: async () => assert.fail('invalid timestamps cannot be waited on')
    });
    await assert.rejects(budget.claim(claim), { budgetReason: 'storage-unavailable' });
  }
});

test('the default pacing wait is abortable without another claim or refund', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const budget = createMidgardRequestBudget({ total, bulk, portal,
    client: { async query(sql) {
      assert.doesNotMatch(sql, /refund/);
      attempts++;
      setImmediate(() => controller.abort());
      return { rows: [{ allowed: false, reason: 'pacing', retry_at: new Date(Date.now() + 200) }] };
    } }
  });
  await assert.rejects(budget.claim({ ...claim, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(attempts, 1);
});

test('canceling an admitted paced request still refunds its exact reservation only once', async () => {
  const reserved = new Date(instant);
  let refunds = 0;
  const budget = createMidgardRequestBudget({ total, bulk, portal,
    client: { async query(sql, values) {
      if (sql.includes('refund_')) {
        refunds++;
        assert.deepEqual(values, ['fixture', true, reserved]);
        return { rows: [] };
      }
      return { rows: [{ allowed: true, reserved_at: reserved }] };
    } }
  });
  const receipt = await budget.claim({ ...claim, budgetClass: 'bulk' });
  await receipt.cancel();
  await receipt.cancel();
  assert.equal(refunds, 1);
});

test('Portal sustained caps inherit legacy operator settings while explicit Portal settings win', () => {
  const source = `
    import { config } from './backend/src/lib/config.js';
    import { midgardRequestBudget } from './backend/src/lib/midgard-request-budget.js';
    console.log(JSON.stringify({ total: config.midgardPortalRequestBudgetTotal,
      bulk: config.midgardPortalRequestBudgetBulk, interval: config.midgardPortalRequestMinIntervalMs,
      enabled: midgardRequestBudget !== null }));
  `;
  const env = { ...process.env, BOONETOOLS_ENV_FILE: '/dev/null', MIDGARD_REQUEST_BUDGET_ENABLED: 'false',
    MIDGARD_REQUEST_BUDGET_TOTAL_HOUR: '1600', MIDGARD_REQUEST_BUDGET_TOTAL_DAY: '12000',
    MIDGARD_REQUEST_BUDGET_BULK_HOUR: '800', MIDGARD_REQUEST_BUDGET_BULK_DAY: '4000' };
  for (const name of Object.keys(env)) if (name.startsWith('MIDGARD_PORTAL_')) delete env[name];
  const readConfig = (extra = {}) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: new URL('../../', import.meta.url), env: { ...env, ...extra }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  assert.deepEqual(readConfig(), { total: { minute: 180, hour: 1600, day: 12000 },
    bulk: { minute: 60, hour: 800, day: 4000 }, interval: 200, enabled: false });
  assert.deepEqual(readConfig({ MIDGARD_PORTAL_REQUEST_BUDGET_TOTAL_HOUR: '1800',
    MIDGARD_PORTAL_REQUEST_BUDGET_BULK_DAY: '3000' }), {
    total: { minute: 180, hour: 1800, day: 12000 }, bulk: { minute: 60, hour: 800, day: 3000 },
    interval: 200, enabled: false
  });
});
