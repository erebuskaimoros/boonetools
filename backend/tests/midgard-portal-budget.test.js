import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/lib/config.js';
import { createMidgardRequestBudget, midgardBudgetContext } from '../src/lib/midgard-request-budget.js';

const PUBLIC = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
const PORTAL = 'https://gateway.liquify.com/api=fixture-not-a-secret/v2';
const total = { minute: 60, hour: 2000, day: 20000 };
const bulk = { minute: 30, hour: 1000, day: 5000 };
const portal = { total: { ...total, minute: 180 }, bulk: { ...bulk, minute: 60 }, minIntervalMs: 200 };
const context = (base, route = '/health', configuredBases = [PORTAL]) =>
  midgardBudgetContext(`${base}${route}`, { bases: [base], configuredBases });

test('only configured HTTPS Liquify Portal Midgard credentials get the relaxed profile', () => {
  assert.equal(context(PORTAL).budgetProfile, 'liquify-portal');
  assert.equal(context(PUBLIC).budgetProfile, 'default');
  assert.equal(context('https://midgard.example/api=fixture/v2', '/health', ['https://midgard.example/api=fixture/v2']).budgetProfile, 'default');
  assert.equal(context('http://gateway.liquify.com/api=fixture/v2', '/health', ['http://gateway.liquify.com/api=fixture/v2']).budgetProfile, 'default');
  assert.equal(midgardBudgetContext('https://gateway.liquify.com/api=unconfigured/v2/health', {
    bases: ['https://gateway.liquify.com'], configuredBases: [PORTAL]
  }), null);
  assert.equal(midgardBudgetContext(`${PORTAL}/actions?limit=50`, {
    bases: ['https://gateway.liquify.com'], configuredBases: [PORTAL]
  }).budgetProfile, 'liquify-portal');
});

test('Free Portal defaults relax burst capacity without raising hourly or daily allowances', () => {
  assert.deepEqual(config.midgardPortalRequestBudgetTotal, portal.total);
  assert.deepEqual(config.midgardPortalRequestBudgetBulk, portal.bulk);
  assert.equal(config.midgardPortalRequestMinIntervalMs, 200);
  assert.deepEqual(config.midgardRequestBudgetTotal, total);
  assert.deepEqual(config.midgardRequestBudgetBulk, bulk);
});

test('a 44-pool refresh survives the observed 28-request competing burst', async () => {
  let instant = Date.parse('2099-01-01T00:00:01Z');
  let spent = 0, nextStart = instant;
  const starts = [];
  const client = { async query(sql, values) {
    const [, , totals] = values;
    if (spent >= totals[0]) return { rows: [{ allowed: false, reason: 'total-minute', retry_at: '2099-01-01T00:01:00Z' }] };
    if (sql.includes('claim_midgard_request_budget_paced') && instant < nextStart) {
      return { rows: [{ allowed: false, reason: 'pacing', retry_at: new Date(nextStart) }] };
    }
    spent++;
    starts.push(instant);
    nextStart = instant + (sql.includes('claim_midgard_request_budget_paced') ? values[5] : 0);
    return { rows: [{ allowed: true, reserved_at: new Date(instant) }] };
  } };
  const budget = createMidgardRequestBudget({ client, total, bulk, portal, now: () => instant,
    wait: async (ms) => { instant += ms; } });
  for (let i = 0; i < 28; i++) await budget.claim(context(PORTAL));
  for (let i = 0; i < 44; i++) await budget.claim(context(PORTAL, '/history/swaps?pool=fixture'));
  assert.equal(spent, 72);
  assert.ok(starts.slice(1).every((value, index) => value - starts[index] >= 200), 'all processes share paced admission, not a per-process timer');
});

test('a short shared pacing wait retries admission without spending a request twice', async () => {
  let instant = Date.parse('2099-01-01T00:00:01Z');
  let claims = 0;
  const waits = [];
  const budget = createMidgardRequestBudget({ total, bulk, portal, now: () => instant,
    client: { async query(sql, values) {
      assert.match(sql, /claim_midgard_request_budget_paced/);
      assert.equal(values[5], 200);
      claims++;
      return { rows: [claims === 1
        ? { allowed: false, reason: 'pacing', retry_at: new Date(instant + 200) }
        : { allowed: true, reserved_at: new Date(instant) }] };
    } }, wait: async (ms) => { waits.push(ms); instant += ms; }
  });
  await budget.claim(context(PORTAL));
  assert.equal(claims, 2);
  assert.deepEqual(waits, [200]);
});

test('real quota deferrals are not slept through or retried', async () => {
  let claims = 0;
  const budget = createMidgardRequestBudget({ total, bulk, portal,
    client: { async query() { claims++; return { rows: [{ allowed: false, reason: 'bulk-day', retry_at: '2099-01-02T00:00:00Z' }] }; } },
    wait: async () => assert.fail('daily exhaustion must defer the caller') });
  await assert.rejects(budget.claim(context(PORTAL, '/actions?limit=50')), { budgetReason: 'bulk-day' });
  assert.equal(claims, 1);
});

test('cancellation while pacing aborts before another admission attempt', async () => {
  const controller = new AbortController();
  let claims = 0;
  const instant = Date.parse('2099-01-01T00:00:01Z');
  const budget = createMidgardRequestBudget({ total, bulk, portal, now: () => instant,
    client: { async query() { claims++; return { rows: [{ allowed: false, reason: 'pacing', retry_at: new Date(instant + 200) }] }; } },
    wait: async () => { controller.abort(); } });
  await assert.rejects(budget.claim({ ...context(PORTAL), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(claims, 1);
});
