import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createFinancialsProviderRequest } from '../src/jobs/financials.js';
import { comparisonRequest } from '../src/jobs/protocol-fee-comparison.js';
import { requestFromProviders } from '../src/lib/provider-client.js';
import { providerLifecycleHooks } from '../src/shared/provider-cooldown.js';
import { config } from '../src/lib/config.js';

const secret = 'test-midgard-credential';
const dedicated = `https://gateway.liquify.com/api=${secret}/v2`;

test('Financials routes history, live health and day actions through configured Midgard', async () => {
  const calls = [];
  const request = createFinancialsProviderRequest(null, { midgardBases: [dedicated],
    transport: async options => { calls.push(options); return {}; } });
  for (const route of ['/history/swaps?interval=day', '/health', '/actions?limit=50']) {
    await request(route, { midgardBudgetClass: 'bulk' });
    assert.deepEqual(calls.at(-1).bases, [dedicated]);
    assert.equal(calls.at(-1).path, route);
    assert.equal(calls.at(-1).midgardBudgetClass, 'bulk');
  }
  await request('/block?height=28000000', { service: 'rpc' });
  assert.deepEqual(calls.at(-1).bases, config.rpcRestUrls, 'RPC routing is unchanged');
});

test('comparison routes only the Midgard service through configured credentials', async () => {
  const calls = [];
  const request = comparisonRequest(null, { midgardBases: [dedicated],
    transport: async options => { calls.push(options); return {}; } });
  await request('/history/earnings?interval=day', { service: 'midgard' });
  assert.deepEqual(calls.at(-1).bases, [dedicated]);
  assert.equal(calls.at(-1).path, '/history/earnings?interval=day');
  for (const url of ['https://api.llama.fi/overview/fees', 'https://coins.llama.fi/chart/near']) {
    await request(url);
    assert.deepEqual(calls.at(-1).bases, [new URL(url).origin]);
    assert.equal(calls.at(-1).path, new URL(url).pathname);
  }
  assert.throws(() => request('https://gateway.liquify.com/chain/thorchain_midgard/v2/health'), /not allowlisted/);
});

test('dedicated transport failures redact keys before persistence and public-facing errors', async () => {
  const writes = [];
  const client = { query: async (sql, values) => { writes.push({ sql, values }); return { rows: [] }; } };
  await assert.rejects(requestFromProviders({ bases: [dedicated], path: '/health', providerPool: false,
    midgardBudget: null, ...providerLifecycleHooks({ client, enabled: true }),
    fetchImpl: async () => new Response(`request to /api=${secret}/v2 failed (${secret})`, { status: 429 })
  }), error => {
    assert.equal(error.status, 429);
    for (const field of ['message', 'body', 'url', 'provider', 'stack']) {
      assert.ok(!String(error[field]).includes(secret), `credential leaked in ${field}`);
    }
    return true;
  });
  assert.ok(writes.some(row => /insert into provider_circuit_breakers/.test(row.sql)));
  assert.ok(!JSON.stringify(writes).includes(secret));
});

test('dedicated request cancellation retains its original reason and does not create a breaker', async () => {
  const controller = new AbortController();
  let failures = 0;
  const pending = requestFromProviders({ bases: [dedicated], path: '/health', providerPool: false,
    midgardBudget: null, request: { signal: controller.signal }, onProviderError: () => failures++,
    fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error === controller.signal.reason);
  assert.equal(failures, 0);
});

test('nested transport causes cannot expose a dedicated key', async () => {
  await assert.rejects(requestFromProviders({ bases: [dedicated], path: '/health', providerPool: false,
    midgardBudget: null, fetchImpl: async () => {
      throw new Error('fetch failed', { cause: new Error(`upstream ${dedicated}`) });
    }
  }), error => {
    assert.ok(!error.cause.message.includes(secret));
    assert.ok(!error.cause.stack.includes(secret));
    return true;
  });
});

test('server environment drives all adapters with one dedicated budget identity and no public fallback', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { config } from './src/lib/config.js';
    import { requestFromProviders } from './src/lib/provider-client.js';
    import { fetchMidgard } from './src/shared/midgard.js';
    import { createFinancialsProviderRequest } from './src/jobs/financials.js';
    import { comparisonRequest } from './src/jobs/protocol-fee-comparison.js';
    const urls = [], claims = [];
    const budget = { async claim(context) { claims.push(context); } };
    globalThis.fetch = async url => { urls.push(url); return new Response('{"ok":true}'); };
    const transport = options => requestFromProviders({ ...options, providerPool: false, midgardBudget: budget });
    await fetchMidgard('/health', { midgardBudget: budget });
    await createFinancialsProviderRequest(null, { transport })('/actions?limit=50');
    await comparisonRequest(null, { transport })('/history/earnings?interval=day', { service: 'midgard' });
    assert.equal(urls.length, 3);
    assert.ok(urls.every(url => url.startsWith(config.midgardUrl + '/')));
    assert.equal(claims.length, 3);
    assert.equal(new Set(claims.map(claim => claim.providerKey)).size, 1);
    assert.deepEqual(claims.map(claim => claim.budgetClass), ['live', 'bulk', 'live']);
    assert.deepEqual(config.rujiraBaseFeesMidgardUrls, [config.midgardUrl]);
    assert.deepEqual(config.rujiraReservePaymentsMidgardUrls, [config.midgardUrl]);
    assert.ok(!JSON.stringify(claims.map(claim => claim.providerKey)).includes('test-midgard-credential'));
  `], { cwd: new URL('../', import.meta.url), env: { ...process.env, NODE_ENV: 'test',
    BOONETOOLS_ENV_FILE: '/dev/null', PROVIDER_COOLDOWN_ENABLED: 'false', MIDGARD_REQUEST_BUDGET_ENABLED: 'false',
    MIDGARD_URL: dedicated, MIDGARD_URLS: dedicated,
    RUJIRA_BASE_FEES_MIDGARD_URLS: dedicated, RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS: dedicated } });
});
