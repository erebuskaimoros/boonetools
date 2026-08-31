import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildChainEventStreamUrl,
  parseChainHeadEvent,
  subscribeChainHeads
} from '../src/lib/api/chain-stream.js';
import { fetchBlockIntervals } from '../src/lib/status/api.js';

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  removeEventListener(name) {
    this.listeners.delete(name);
  }

  emit(name, data = '') {
    this.listeners.get(name)?.({ data });
  }

  close() {
    this.closed = true;
  }
}

test('site-owned chain stream parses and subscribes to compact head events', () => {
  assert.equal(
    buildChainEventStreamUrl({ base: 'https://api.example/functions/v1/' }),
    'https://api.example/functions/v1/chain-events'
  );
  assert.deepEqual(parseChainHeadEvent(JSON.stringify({
    height: 123,
    time: '2026-08-05T12:00:00Z',
    interval_ms: 6125,
    has_swap_events: true,
    pol_reserve_reward_e8: '9',
    pol_reserve_deployments: [{ asset: 'BTC.BTC', rune_e8: '7', units_e8: '3' }]
  })), {
    height: 123,
    time: '2026-08-05T12:00:00.000Z',
    time_ms: Date.parse('2026-08-05T12:00:00Z'),
    interval_ms: 6125,
    block_hash: '',
    has_swap_events: true,
    income_burn_e8: null,
    pol_reserve_reward_e8: '9',
    pol_reserve_deployments: [{ asset: 'BTC.BTC', rune_e8: '7', units_e8: '3' }],
    source: 'liquify-ws'
  });

  assert.deepEqual(parseChainHeadEvent(JSON.stringify({
    height: 124,
    time: '2026-08-05T12:00:06Z',
    pol_reserve_deployments: [{ asset: 'ETH.ETH', rune_e8: '7', units_e8: null }]
  }))?.pol_reserve_deployments, [{ asset: 'ETH.ETH', rune_e8: '7', units_e8: null }]);

  const heads = [];
  const subscription = subscribeChainHeads({
    base: '/functions/v1',
    EventSourceCtor: FakeEventSource,
    onHead: (head) => heads.push(head)
  });
  assert.equal(subscription.source.url, '/functions/v1/chain-events');
  subscription.source.emit('head', JSON.stringify({
    height: 124,
    time: '2026-08-05T12:00:06Z',
    interval_ms: 6000
  }));
  assert.equal(heads[0].height, 124);
  assert.equal(heads[0].income_burn_e8, null);
  subscription.close();
  assert.equal(subscription.source.closed, true);
});

test('block interval adapter requests initial and incremental compact history', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() {
        return { points: [], columns: [] };
      }
    };
  };

  await fetchBlockIntervals({ hours: 24 });
  await fetchBlockIntervals({ hours: 24, afterHeight: 123 });
  assert.deepEqual(requests.map((request) => request.url), [
    '/functions/v1/block-production?hours=24',
    '/functions/v1/block-production?hours=24&after_height=123'
  ]);
  assert.equal(requests.every((request) => request.options.cache === 'no-store'), true);
});

test('browser dashboards consume the site-owned stream instead of opening Liquify sockets', () => {
  const dynamicFees = readFileSync(
    new URL('../src/lib/DynamicFeeDashboard.svelte', import.meta.url),
    'utf8'
  );
  const limitOrders = readFileSync(
    new URL('../src/lib/LimitOrders.svelte', import.meta.url),
    'utf8'
  );
  for (const source of [dynamicFees, limitOrders]) {
    assert.match(source, /subscribeChainHeads/);
    assert.doesNotMatch(source, /new\s+WebSocket/);
    assert.doesNotMatch(source, /wss:\/\/gateway\.liquify\.com/);
  }
  assert.match(limitOrders, /has_swap_events/);
});
