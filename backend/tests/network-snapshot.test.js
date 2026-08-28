import test from 'node:test';
import assert from 'node:assert/strict';

import { TtlSingleFlightCache } from '../src/lib/ttl-cache.js';
import { getNetworkSnapshot } from '../src/shared/network-snapshot.js';

test('network snapshot coalesces shared public THORNode and Midgard state', async () => {
  const calls = [];
  const payloads = new Map([
    ['/thorchain/inbound_addresses', [{ chain: 'BTC' }]],
    ['/thorchain/nodes', [{ node_address: 'thor1node' }]],
    ['/thorchain/mimir', { HALTTRADING: 0 }],
    ['/thorchain/lastblock', [{ chain: 'BTC', thorchain: 123 }]]
  ]);
  const cache = new TtlSingleFlightCache({ ttlMs: 15000 });
  const snapshot = await getNetworkSnapshot({
    cache,
    fetchThorchain: async (path) => {
      calls.push(path);
      return payloads.get(path);
    },
    fetchMidgardChurns: async () => [{ height: 100 }],
    fetchBifrostScannerInfo: async () => [{ node_address: 'thor1node', scanner: { BTC: { scanner_height_diff: 1 } } }]
  });

  assert.deepEqual(calls.sort(), [...payloads.keys()].sort());
  assert.deepEqual(snapshot.inbound_addresses, [{ chain: 'BTC' }]);
  assert.deepEqual(snapshot.churns, [{ height: 100 }]);
  assert.equal(snapshot.bifrost_scanners[0].scanner.BTC.scanner_height_diff, 1);
  assert.equal(snapshot.source.live, 'thornode');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.partial, false);
});

test('network snapshot retains THORNode state when Midgard churns are unavailable', async () => {
  const snapshot = await getNetworkSnapshot({
    cache: new TtlSingleFlightCache({ ttlMs: 15000 }),
    fetchThorchain: async (path) => path === '/thorchain/mimir' ? {} : [],
    fetchMidgardChurns: async () => {
      throw new Error('midgard unavailable');
    },
    fetchBifrostScannerInfo: async () => []
  });

  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.churns, []);
  assert.match(snapshot.errors.churns, /midgard unavailable/);
});

test('network snapshot serves stale data after a provider refresh failure', async () => {
  let now = 0;
  const cache = new TtlSingleFlightCache({ ttlMs: 1, now: () => now });
  const options = {
    cache,
    fetchThorchain: async () => [],
    fetchMidgardChurns: async () => [],
    fetchBifrostScannerInfo: async () => []
  };
  await getNetworkSnapshot(options);
  now = 2;

  const stale = await getNetworkSnapshot({
    ...options,
    fetchThorchain: async () => { throw new Error('provider unavailable'); },
    fetchMidgardChurns: async () => { throw new Error('midgard unavailable'); },
    fetchBifrostScannerInfo: async () => { throw new Error('scanner unavailable'); }
  });

  assert.equal(stale.stale, true);
  assert.match(stale.warning, /provider unavailable/);
});

test('forced network refresh retains a usable stale snapshot on total outage', async () => {
  const cache = new TtlSingleFlightCache({ ttlMs: 15000 });
  const options = {
    cache,
    fetchThorchain: async (path) => path === '/thorchain/mimir' ? {} : [],
    fetchMidgardChurns: async () => [],
    fetchBifrostScannerInfo: async () => []
  };
  await getNetworkSnapshot(options);

  const stale = await getNetworkSnapshot({
    ...options,
    forceRefresh: true,
    fetchThorchain: async () => { throw new Error('thornode unavailable'); },
    fetchMidgardChurns: async () => { throw new Error('midgard unavailable'); },
    fetchBifrostScannerInfo: async () => { throw new Error('scanner unavailable'); }
  });

  assert.equal(stale.stale, true);
  assert.match(stale.warning, /Network snapshot unavailable/);
});

test('network snapshot rejects a Midgard-only result when every THORNode field fails', async () => {
  await assert.rejects(() => getNetworkSnapshot({
    cache: new TtlSingleFlightCache({ ttlMs: 15000 }),
    fetchThorchain: async () => { throw new Error('thornode blocked'); },
    fetchMidgardChurns: async () => [{ height: 100 }],
    fetchBifrostScannerInfo: async () => []
  }), /Network snapshot unavailable/);
});

test('network snapshot surfaces scanner failure without marking THORNode state stale', async () => {
  const snapshot = await getNetworkSnapshot({
    cache: new TtlSingleFlightCache({ ttlMs: 15000 }),
    fetchThorchain: async (path) => path === '/thorchain/mimir' ? {} : [],
    fetchMidgardChurns: async () => [],
    fetchBifrostScannerInfo: async () => { throw new Error('scanner unavailable'); }
  });

  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.bifrost_scanners, []);
  assert.match(snapshot.warnings.join(' '), /bifrost_scanners: scanner unavailable/);
});
