import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createProviderServices, PUBLIC_PROVIDER_SERVICES } from '../shared/provider-services.js';

test('service dispatch preserves options and cannot be redirected by a route or option override', async () => {
  const calls = [], bases = ['https://example.test/api=fake/v2/'];
  const request = createProviderServices({ services: { midgard: bases },
    transport: async options => { calls.push(options); return {}; },
    defaults: { timeoutMs: 123, headers: { Accept: 'application/json' } } });
  bases.push('https://untrusted.test');
  const controller = new AbortController();
  await request('midgard', '/health', { bases: ['https://untrusted.test'], path: '/other',
    request: { signal: controller.signal }, midgardBudgetClass: 'bulk', headers: { 'x-client-id': 'test' } });
  assert.deepEqual(calls[0].bases, ['https://example.test/api=fake/v2']);
  assert.equal(calls[0].path, '/health');
  assert.equal(calls[0].timeoutMs, 123);
  assert.equal(calls[0].request.signal, controller.signal);
  assert.equal(calls[0].midgardBudgetClass, 'bulk');
  assert.deepEqual(calls[0].headers, { Accept: 'application/json', 'x-client-id': 'test' });
  for (const route of ['https://other.test/health', '//other.test/health', '/../health', '/%2e%2e/health', '/x#y', '/\\other.test']) {
    assert.throws(() => request('midgard', route), /service base/);
  }
  assert.throws(() => request('unknown', '/health'), /not configured/);
  assert.equal(calls.length, 1);
});

test('runtime-neutral public routes ignore private environment; backend defaults inherit resolved Midgard list', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { config } from './backend/src/lib/config.js';
    import { MIDGARD_BASES } from './shared/rapid-swaps/backend.js';
    import { MIDGARD_PUBLIC_URLS } from './shared/thorchain-providers.js';
    import './backend/src/shared/rapid-swaps.js';
    import { fetchMidgardActions } from './shared/rapid-swaps/backend.js';
    assert.deepEqual(MIDGARD_BASES, MIDGARD_PUBLIC_URLS);
    assert.deepEqual(config.midgardUrls, ['https://private.example/v2']);
    assert.deepEqual(config.rujiraBaseFeesMidgardUrls, config.midgardUrls);
    assert.deepEqual(config.rujiraReservePaymentsMidgardUrls, ['https://override.example/v2']);
    globalThis.fetch = async url => { assert.ok(url.startsWith(config.midgardUrls[0])); return Response.json({actions: []}); };
    await fetchMidgardActions({limit: 1});
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, BOONETOOLS_ENV_FILE: '/dev/null',
      NODE_ENV: 'test', PROVIDER_COOLDOWN_ENABLED: 'false', MIDGARD_REQUEST_BUDGET_ENABLED: 'false',
      MIDGARD_URL: 'https://scalar.example/v2', MIDGARD_URLS: 'https://private.example/v2',
      RUJIRA_BASE_FEES_MIDGARD_URLS: '', RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS: 'https://override.example/v2' }
  });
  assert.ok(PUBLIC_PROVIDER_SERVICES.midgard.every(base => !base.includes('private')));
});
