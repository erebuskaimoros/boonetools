import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProviderCooldownError,
  assertProviderAvailable,
  providerCooldownKeys,
  isProviderRateLimitError,
  recordProviderFailure,
  recordProviderSuccess
} from '../src/shared/provider-cooldown.js';

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
  const queries = [];
  const client = { query: async (sql, params) => (queries.push({ sql, params }), { rows: [] }) };
  await recordProviderFailure(
    'https://gateway.liquify.com/chain/thorchain_rpc',
    Object.assign(new Error('Too many requests'), { status: 429, retryAfterSeconds: 120 }),
    { client, enabled: true }
  );
  assert.equal(queries[0].params[0], 'global:gateway.liquify.com');
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
