import assert from 'node:assert/strict';
import test from 'node:test';
import { requestFromProviders } from '../src/lib/provider-client.js';
import { midgardBudgetContext, MidgardBudgetDeferredError } from '../src/lib/midgard-request-budget.js';

const BASE = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
const TX = '9CE9A691673C6262743B95CA626C3DE981990F2A165CC88317E005A740127595';

test('a bounded saved-transaction verification can finish after the historical bulk allowance is exhausted', async () => {
  let requests = 0;
  const classes = [];
  const result = await requestFromProviders({
    bases: [BASE], path: `/actions?txid=${TX}&limit=50`, providerPool: false,
    midgardBudgetClass: 'verification',
    midgardBudget: { claim: async context => {
      classes.push(context.budgetClass);
      if (context.budgetClass === 'bulk') throw new MidgardBudgetDeferredError({
        providerKey: 'test', retryAt: '2026-10-30T00:00:00Z', reason: 'bulk-day'
      });
    } },
    fetchImpl: async () => { requests++; return new Response(JSON.stringify({ actions: [{ status: 'success' }] })); }
  });
  assert.equal(result.actions[0].status, 'success');
  assert.deepEqual(classes, ['live']);
  assert.equal(requests, 1);
});

test('verification admission never reclassifies scans or pagination as live requests', () => {
  for (const route of [
    '/actions?limit=50', '/actions?address=someone&limit=50',
    `/actions?txid=${TX}`, '/actions?txid=&limit=50',
    `/actions?txid=${TX.slice(1)}&limit=50`, `/actions?txid=${'Z'.repeat(64)}&limit=50`,
    `/actions?txid=${TX}&limit=51`, `/actions?txid=${TX}&limit=50&offset=1`,
    `/actions?txid=${TX}&limit=50&nextPageToken=next`,
    `/actions?txid=${TX}&limit=50&offset=0`, `/actions?txid=${TX}&limit=50&type=swap`,
    `/actions?txid=${TX}&limit=50&limit=50`, `/actions?txid=${TX}&limit=0`,
    `/actions?txid=${TX}&limit=-1`, `/actions?txid=${TX}&limit=5e1`,
    `/actions?txid=${TX}&limit=50.0`, `/actions?txid=${TX}&limit=50#cursor`,
    `/actions?txid=${TX}&txid=${'A'.repeat(64)}&limit=50`,
    `/actions?txid=${TX},${'A'.repeat(64)}&limit=50`
  ]) {
    assert.equal(midgardBudgetContext(`${BASE}${route}`, {bases:[BASE],midgardBudgetClass:'verification'}).budgetClass,
      'bulk', route);
  }
  assert.equal(midgardBudgetContext(`${BASE}/actions?txid=${TX}&limit=50`, {bases:[BASE]}).budgetClass, 'bulk');
  assert.equal(midgardBudgetContext(`${BASE}/actions?txid=${TX}&limit=50`, {
    bases: [BASE], midgardBudgetClass: 'live'
  }).budgetClass, 'bulk');
  assert.equal(midgardBudgetContext(`${BASE}/actions?txid=${TX}&limit=50`, {
    bases: [BASE], midgardBudgetClass: 'bulk'
  }).budgetClass, 'bulk');
});

test('verification admission accepts a single bounded transaction across supported base shapes', () => {
  for (const base of [BASE, 'https://midgard.example/v2', 'https://gateway.liquify.com/api=test-dedicated/v2']) {
    for (const limit of [1, 5, 50]) {
      const context = midgardBudgetContext(`${base}/actions?limit=${limit}&txid=${TX.toLowerCase()}`, {
        bases: [base], configuredBases: [base], midgardBudgetClass: 'verification'
      });
      assert.equal(context.budgetClass, 'live');
    }
  }
});

test('targeted verification still stops at the shared total limit before making an HTTP request', async () => {
  let requests = 0;
  const denied = new MidgardBudgetDeferredError({providerKey:'test',retryAt:'2026-10-30T00:00:00Z',reason:'total-day'});
  await assert.rejects(requestFromProviders({
    bases:[BASE],path:`/actions?txid=${TX}&limit=50`,providerPool:false,midgardBudgetClass:'verification',
    midgardBudget:{claim:async()=>{throw denied;}},fetchImpl:async()=>{requests++;return new Response('{}');}
  }), error=>error===denied);
  assert.equal(requests,0);
});
