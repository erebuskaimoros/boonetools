import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMidgard, fetchMidgardActions } from '../src/shared/midgard.js';
import { ProviderCooldownError } from '../src/shared/provider-cooldown.js';

const BASE = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';

function fixture(t, actionFailure) {
  const breakers = new Map();
  const calls = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('select provider_key')) {
        return { rows: params[0].flatMap((key) => breakers.has(key) ? [breakers.get(key)] : []) };
      }
      if (sql.includes('insert into provider_circuit_breakers')) {
        const [key, lastStatus, lastError, blockedUntil] = params;
        const previous = breakers.get(key);
        breakers.set(key, {
          provider_key: key,
          last_status: lastStatus,
          last_error: lastError,
          failure_count: (previous?.failure_count || 0) + 1,
          blocked_until: previous?.blocked_until > blockedUntil ? previous.blocked_until : blockedUntil
        });
        return { rows: [] };
      }
      if (sql.includes('update provider_circuit_breakers')) {
        const row = breakers.get(params[0]);
        if (row) Object.assign(row, { failure_count: 0, blocked_until: null, last_error: '' });
        return { rows: [] };
      }
      assert.fail(`Unexpected cooldown query: ${sql}`);
    }
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = String(url).slice(BASE.length);
    calls.push(route);
    if (route.startsWith('/actions')) return actionFailure();
    return new Response(JSON.stringify(route === '/health'
      ? { database: true, inSync: true, lastAggregated: { height: 1, timestamp: 1788999300 } }
      : { intervals: [], meta: { totalVolume: '100', totalFees: '2' } }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  return { calls, breakers, options: { bases: [BASE], cooldownClient: client, sharedCooldown: true } };
}

for (const failure of ['timeout', 'HTTP 500']) {
  test(`Midgard actions ${failure} does not block Pool Analysis health or swap history`, async (t) => {
    const f = fixture(t, () => {
      if (failure === 'timeout') throw new DOMException('This operation was aborted', 'AbortError');
      return new Response('upstream failure', { status: 500 });
    });
    // Base Fees calls fetchMidgard directly; other collectors use the actions helper.
    await assert.rejects(() => fetchMidgard('/actions?type=swap&limit=50', f.options));
    await assert.rejects(() => fetchMidgardActions({ address: 'another-collector' }, f.options), ProviderCooldownError);
    assert.deepEqual(f.calls, ['/actions?type=swap&limit=50']);

    const health = await fetchMidgard('/health', f.options);
    assert.equal(health.inSync, true);
    const history = await fetchMidgard('/history/swaps?pool=BTC.BTC&from=1788998400&to=1788999300', f.options);
    assert.equal(history.meta.totalVolume, '100');
    // Successful pool requests must not clear the still-active actions cooldown.
    await assert.rejects(() => fetchMidgardActions({ offset: 50 }, f.options), ProviderCooldownError);
    assert.equal(f.calls.length, 3);
  });
}

for (const response of [
  { status: 429, headers: {}, name: 'HTTP 429' },
  { status: 503, headers: { 'retry-after': '120' }, name: 'Retry-After' }
]) {
  test(`Midgard actions ${response.name} still blocks health and history through the shared gateway cooldown`, async (t) => {
    const f = fixture(t, () => new Response('provider unavailable', response));
    await assert.rejects(() => fetchMidgardActions({ limit: 50 }, f.options));
    for (const route of ['/health', '/history/swaps?pool=BTC.BTC', '/network']) {
      await assert.rejects(() => fetchMidgard(route, f.options), ProviderCooldownError);
    }
    assert.equal(f.calls.length, 1, 'A gateway cooldown must prevent further outbound requests');
  });
}
