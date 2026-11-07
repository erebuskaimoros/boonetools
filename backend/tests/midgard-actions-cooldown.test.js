import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMidgard, fetchMidgardActions } from '../src/shared/midgard.js';
import { ProviderCooldownError } from '../src/shared/provider-cooldown.js';
import { thorchainProviderPool } from '../src/lib/provider-client.js';
import { createThorchainProviderPool } from '../../shared/thorchain-provider-pool.js';

const BASE = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';

function fixture(t, actionFailure, failurePath = '/actions', base = BASE) {
  // Give each fixture fresh process-local breakers as well as its own database.
  const localPool = createThorchainProviderPool();
  t.mock.method(thorchainProviderPool, 'acquire', localPool.acquire);
  t.mock.method(thorchainProviderPool, 'failure', localPool.failure);
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
    const route = String(url).slice(base.length);
    calls.push(route);
    if (route.startsWith(failurePath)) return actionFailure();
    return new Response(JSON.stringify(route === '/health'
      ? { database: true, inSync: true, lastAggregated: { height: 1, timestamp: 1788999300 } }
      : route.startsWith('/history/rune')
        ? { intervals: [{ startTime: '1', endTime: '2', runePriceUSD: '0.6' }] }
        : { intervals: [], meta: { totalVolume: '100', totalFees: '2' } }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  return { calls, breakers, options: { bases: [base], cooldownClient: client, sharedCooldown: true } };
}

test('swap-history failures pause every pool/query on that endpoint without blocking depth or health', async t => {
  const f = fixture(t, () => new Response('no available nodes', { status: 503 }), '/history/swaps');
  await assert.rejects(() => fetchMidgard('/history/swaps?pool=BTC.BTC&from=1&to=2', f.options));
  await assert.rejects(() => fetchMidgard('/history/swaps/?pool=ZEC.ZEC&from=3&to=4', f.options), ProviderCooldownError);
  assert.equal((await fetchMidgard('/health', f.options)).inSync, true);
  await fetchMidgard('/history/depths/ZEC.ZEC?from=1&to=2', f.options);
  await assert.rejects(() => fetchMidgard('/history/swaps?pool=ETH.ETH', f.options), ProviderCooldownError);
  assert.equal(f.calls.length, 3, 'asset and query changes must not evade the failed endpoint cooldown');
});

for (const base of [BASE, 'https://gateway.liquify.com/api=test-churn-isolation/v2']) {
  for (const [endpoint, status] of [['/churns', 503], ['/network', 500]]) {
    test(`a ${endpoint} ${status} does not suppress Pool Analysis health/history on ${base.includes('api=') ? 'dedicated' : 'public'} Midgard`, async t => {
      const f = fixture(t, () => new Response('upstream unavailable', { status }), endpoint, base);
      await assert.rejects(() => fetchMidgard(endpoint, f.options));
      await assert.rejects(() => fetchMidgard(endpoint, f.options), ProviderCooldownError);
      const health = await fetchMidgard('/health', f.options);
      assert.equal(health.inSync, true);
      const history = await fetchMidgard('/history/swaps?pool=ZEC.ZEC&from=1793318400&to=1793333700', f.options);
      assert.equal(history.meta.totalVolume, '100');
      await assert.rejects(() => fetchMidgard(endpoint, f.options), ProviderCooldownError);
      assert.equal(f.calls.length, 3, 'only the failed endpoint pauses; unrelated requests must not clear its cooldown');
    });
  }
}

for (const [failed, variant, healthy] of [
  ['/health', '/health/?check=another', '/network'],
  ['/bonds/thor1first', '/bonds/thor1second', '/health'],
  ['/history/depths/BTC.BTC?from=1', '/history/depths/ZEC.ZEC?from=2', '/history/swaps?pool=BTC.BTC'],
  ['/history/earnings?from=1', '/history/earnings/?from=2', '/history/swaps?pool=BTC.BTC'],
  ['/history/rune?interval=week&from=1', '/history/rune/?interval=day&from=2', '/health']
]) {
  test(`${failed} shares its failure across resource/query variants without blocking ${healthy}`, async t => {
    const f = fixture(t, () => new Response('upstream unavailable', { status: 503 }), failed);
    await assert.rejects(() => fetchMidgard(failed, f.options));
    await assert.rejects(() => fetchMidgard(variant, f.options), ProviderCooldownError);
    await fetchMidgard(healthy, f.options);
    await assert.rejects(() => fetchMidgard(variant, f.options), ProviderCooldownError);
    assert.deepEqual(f.calls, [failed, healthy]);
  });
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

for (const base of [BASE, 'https://gateway.liquify.com/api=test-shared-cooldown/v2']) {
  for (const endpoint of ['/actions', '/churns', '/network']) {
    for (const response of [
      { status: 429, headers: {}, name: 'HTTP 429' },
      { status: 503, headers: { 'retry-after': '120' }, name: 'Retry-After' }
    ]) {
      test(`Midgard ${endpoint} ${response.name} still blocks other endpoints on ${base.includes('api=') ? 'dedicated' : 'public'} Midgard`, async (t) => {
        const f = fixture(t, () => new Response('provider unavailable', response), endpoint, base);
        await assert.rejects(() => fetchMidgard(endpoint, f.options));
        for (const route of ['/health', '/history/swaps?pool=BTC.BTC', '/history/depths/BTC.BTC', '/history/rune?interval=week&from=1&to=2', '/network', '/bonds/thor1test']) {
          await assert.rejects(() => fetchMidgard(route, f.options), ProviderCooldownError);
        }
        assert.equal(f.calls.length, 1, 'A gateway cooldown must prevent further outbound requests');
      });
    }
  }
}


test('RUNE pricing is isolated from generic service failures but shares its own history cooldown', async t => {
  const f = fixture(t, () => { throw new DOMException('This operation was aborted', 'AbortError'); },
    '/pools', 'https://gateway.liquify.com/api=test-rune-pricing-isolation/v2');
  await assert.rejects(() => fetchMidgard('/pools', f.options));
  await fetchMidgard('/history/rune?interval=week&from=1&to=2', f.options);
  await assert.rejects(() => fetchMidgard('/pools', f.options), ProviderCooldownError);
  assert.equal(f.calls.length, 2, 'unrelated service failure must not suppress available fee pricing');
});
