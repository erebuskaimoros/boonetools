import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/lib/config.js';

import {
  ProviderCooldownError,
  assertProviderAvailable,
  providerCooldownKeys,
  isProviderRateLimitError,
  recordProviderFailure,
  recordProviderSuccess
} from '../src/shared/provider-cooldown.js';

test('provider cooldown does not mistake a block height or hash containing 429 for throttling', async () => {
  const queries = [];
  const client = { query: async (sql, params) => (queries.push({ sql, params }), { rows: [] }) };
  for (const message of [
    'Request failed (500) for /thorchain/network?height=28429400',
    'HTTP 500 for https://gateway.liquify.com/chain/thorchain_rpc/tx?hash=0xA429B',
    'HTTP 500 for https://gateway.liquify.com/chain/thorchain_rpc/block?height=429'
  ]) {
    const error = Object.assign(new Error(message), { status: 500 });
    const before = Date.now();
    await recordProviderFailure('https://gateway.liquify.com/chain/thorchain_rpc', error, {
      client, enabled: true
    });
    const delay = Date.parse(queries.at(-1).params[3]) - before;
    assert.ok(delay >= config.providerFailureCooldownMs && delay < config.providerFailureCooldownMs + 1000,
      `ordinary failure should get the short cooldown, got ${delay}ms for ${message}`);
    assert.equal(isProviderRateLimitError(error), false);
  }
  assert.equal(isProviderRateLimitError(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(isProviderRateLimitError(new Error('Request failed (429)')), true);
});

test('provider cooldown honors Retry-After on a temporary 503 response', async () => {
  const queries = [];
  const client = { query: async (sql, params) => (queries.push({ sql, params }), { rows: [] }) };
  const retryAfterSeconds = Math.ceil(config.providerFailureCooldownMs / 1000) + 120;
  const before = Date.now();
  await recordProviderFailure(
    'https://gateway.liquify.com/chain/thorchain_rpc',
    Object.assign(new Error('HTTP 503 Service Unavailable'), { status: 503, retryAfterSeconds }),
    { client, enabled: true }
  );
  assert.equal(queries[0].params[0], 'global:gateway.liquify.com');
  assert.ok(Date.parse(queries[0].params[3]) >= before + retryAfterSeconds * 1000);
});

test('provider cooldown keeps non-429 Liquify failures inside their service lane', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    }
  };
  const error = Object.assign(new Error('Request failed (403)'), {
    status: 403,
    body: 'Too many breaches; temporarily blocked'
  });
  assert.equal(isProviderRateLimitError(error), true);
  await recordProviderFailure('https://gateway.liquify.com/chain/thorchain_api', error, {
    client,
    enabled: true
  });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].params[0], 'service:gateway.liquify.com/chain/thorchain_api');
  assert.ok(Date.parse(queries[0].params[3]) > Date.now());
});

test('provider cooldown reserves the gateway-wide lane for 429 or Retry-After responses', async () => {
  const keys = providerCooldownKeys('https://gateway.liquify.com/chain/thorchain_midgard/v2');
  assert.deepEqual(keys, {
    global: 'global:gateway.liquify.com',
    service: 'service:gateway.liquify.com/chain/thorchain_midgard'
  });
  assert.equal(
    providerCooldownKeys('https://gateway.liquify.com/chain/thorchain_rpc', {
      scope: 'market snapshots'
    }).service,
    'service:gateway.liquify.com/chain/thorchain_rpc:market-snapshots'
  );
  const queries = [];
  const client = { query: async (sql, params) => (queries.push({ sql, params }), { rows: [] }) };
  await recordProviderFailure(
    'https://gateway.liquify.com/chain/thorchain_rpc',
    Object.assign(new Error('Too many requests'), { status: 429, retryAfterSeconds: 120 }),
    { client, enabled: true }
  );
  assert.equal(queries[0].params[0], 'global:gateway.liquify.com');
});

test('provider cooldown isolates dedicated Liquify endpoints without persisting API keys', async () => {
  const base = 'https://gateway.liquify.com/api=test-secret-value';
  const keys = providerCooldownKeys(base);
  assert.deepEqual(keys, {
    global: 'global:gateway.liquify.com/api=dedicated',
    service: 'service:gateway.liquify.com/api=dedicated'
  });
  assert.equal(JSON.stringify(keys).includes('test-secret-value'), false);

  const queries = [];
  const client = { query: async (sql, params) => (queries.push({ sql, params }), { rows: [] }) };
  await recordProviderFailure(
    base,
    Object.assign(new Error('Too many requests'), { status: 429 }),
    { client, enabled: true }
  );
  assert.equal(queries[0].params[0], 'global:gateway.liquify.com/api=dedicated');
});

test('provider cooldown does not open a breaker for endpoint-specific 404 responses', async () => {
  let queries = 0;
  await recordProviderFailure(
    'https://gateway.liquify.com/chain/thorchain_midgard/v2',
    Object.assign(new Error('not found'), { status: 404 }),
    { client: { query: async () => { queries += 1; return { rows: [] }; } }, enabled: true }
  );
  assert.equal(queries, 0);
});

test('provider cooldown skips blocked hosts and clears state after success', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('where provider_key')) {
        return {
          rows: [{
            provider_key: 'global:gateway.liquify.com',
            blocked_until: '2099-07-27T13:00:00.000Z',
            last_error: 'rate limited'
          }]
        };
      }
      return { rows: [] };
    }
  };
  await assert.rejects(
    () => assertProviderAvailable('https://gateway.liquify.com/chain/thorchain_api', {
      client,
      enabled: true
    }),
    ProviderCooldownError
  );
  await recordProviderSuccess('https://gateway.liquify.com/chain/thorchain_api', {
    client,
    enabled: true
  });
  assert.equal(queries.at(-1).params[0], 'service:gateway.liquify.com/chain/thorchain_api');
});
