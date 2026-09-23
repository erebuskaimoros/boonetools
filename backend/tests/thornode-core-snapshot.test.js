import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THORNODE_CORE_FIELDS,
  buildThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from '../src/shared/thornode-core-snapshot.js';

const START = new Date('2026-07-27T12:00:00.000Z');

function payloadFor(path) {
  if (path === '/thorchain/lastblock') return [{ chain: 'BTC', thorchain: 27957812 }];
  if (path === '/cosmos/bank/v1beta1/supply/by_denom?denom=rune') {
    return { amount: { denom: 'rune', amount: '35402165993252075' } };
  }
  if (path === '/thorchain/mimir') return { HALTTRADING: 0 };
  if (path === '/thorchain/mimir/nodes_all') return { mimirs: [] };
  if (path === '/thorchain/network') return { rune_price_in_tor: '100000000' };
  if (path === '/thorchain/oracle/prices') return { prices: [{ symbol: 'RUNE', price: '1' }] };
  if (path === '/thorchain/constants') return { int_64_values: {} };
  return [];
}

function scannerPayload(diff = 2) {
  return [{
    node_address: 'thor1active',
    scanner: { SOL: { chain_height: 400_000_000, scanner_height_diff: diff } }
  }];
}

test('durable core snapshot staggers fields by their volatility', async () => {
  const firstCalls = [];
  let scannerCalls = 0;
  let midgardNetworkCalls = 0;
  const first = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async (path) => {
      firstCalls.push(path);
      return payloadFor(path);
    },
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => {
      midgardNetworkCalls += 1;
      return { nextChurnHeight: '123456' };
    },
    fetchBifrostScannerInfo: async () => {
      scannerCalls += 1;
      return scannerPayload();
    }
  });
  assert.equal(firstCalls.length, THORNODE_CORE_FIELDS.filter((field) => field.provider === 'thornode').length);
  assert.equal(scannerCalls, 1);
  assert.equal(midgardNetworkCalls, 1);
  assert.equal(first.midgard_network.nextChurnHeight, '123456');
  assert.equal(first.stale, false);

  const secondCalls = [];
  const second = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 15_001),
    previousSnapshot: first,
    fetchThorchain: async (path) => {
      secondCalls.push(path);
      return payloadFor(path);
    },
    fetchMidgardChurns: async () => {
      throw new Error('churns should not be due');
    },
    fetchMidgardNetwork: async () => {
      throw new Error('Midgard network should not be due');
    },
    fetchBifrostScannerInfo: async () => {
      throw new Error('scanners should not be due');
    }
  });
  assert.deepEqual(secondCalls, ['/thorchain/lastblock']);
  assert.equal(second.stale, false);
  assert.deepEqual(second.nodes, first.nodes);
});

test('durable core snapshot preserves values but marks provider-total failure stale', async () => {
  const first = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async (path) => payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => scannerPayload()
  });
  const failed = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 15_001),
    previousSnapshot: first,
    fetchThorchain: async () => { throw new Error('temporarily blocked'); },
    fetchMidgardChurns: async () => [],
    fetchBifrostScannerInfo: async () => scannerPayload()
  });
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.lastblock, first.lastblock);
  assert.match(failed.warnings.join(' '), /reused last successful value/);
});

test('durable core snapshot rejects an empty oracle price set and reuses the last-good value', async () => {
  const first = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async (path) => payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => scannerPayload()
  });
  const refreshed = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 120_001),
    previousSnapshot: first,
    fetchThorchain: async (path) => (
      path === '/thorchain/oracle/prices' ? { prices: [] } : payloadFor(path)
    ),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => scannerPayload()
  });

  assert.deepEqual(refreshed.oracle_prices, first.oracle_prices);
  assert.equal(refreshed.field_meta.oracle_prices.status, 'reused');
  assert.match(refreshed.warnings.join(' '), /oracle\/prices.*reused last successful value/);
});

test('durable core snapshot does not reuse an already-invalid oracle price set', async () => {
  const previous = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async (path) => payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => scannerPayload()
  });
  previous.oracle_prices = { prices: [] };
  const refreshed = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 120_001),
    previousSnapshot: previous,
    fetchThorchain: async (path) => (
      path === '/thorchain/oracle/prices' ? { prices: [] } : payloadFor(path)
    ),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => scannerPayload()
  });

  assert.equal(Object.hasOwn(refreshed, 'oracle_prices'), false);
  assert.equal(refreshed.field_meta.oracle_prices.status, 'error');
  assert.doesNotMatch(refreshed.warnings.join(' '), /oracle\/prices.*reused last successful value/);
});

test('durable core snapshot refuses a first publication without required THORNode fields', async () => {
  await assert.rejects(() => buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async () => { throw new Error('blocked'); },
    fetchMidgardChurns: async () => [{ height: 1 }],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => scannerPayload()
  }), /missing required fields/);
});

test('scanner refresh failure reuses last-good scanner data without staling the THORNode lane', async () => {
  const first = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async (path) => payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => scannerPayload(3)
  });
  const failed = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 300_001),
    previousSnapshot: first,
    fetchThorchain: async (path) => payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({ nextChurnHeight: '123456' }),
    fetchBifrostScannerInfo: async () => { throw new Error('scanner aggregate unavailable'); }
  });

  assert.equal(failed.stale, false);
  assert.equal(failed.partial, true);
  assert.deepEqual(failed.bifrost_scanners, scannerPayload(3));
  assert.equal(failed.field_meta.bifrost_scanners.status, 'reused');
  assert.match(failed.warnings.join(' '), /scanner aggregate unavailable.*reused last successful value/);
});

test('durable core freshness includes model TTL and required field health', () => {
  const payload = {
    stale: false,
    nodes: [],
    mimir: {},
    field_meta: {
      nodes: { status: 'cached' },
      mimir: { status: 'reused' }
    }
  };
  assert.equal(isThorNodeCoreSnapshotStale({ payload, stale: false }, ['nodes']), false);
  assert.equal(isThorNodeCoreSnapshotStale({ payload, stale: false }, ['mimir']), true);
  assert.equal(isThorNodeCoreSnapshotStale({ payload, stale: true }, ['nodes']), true);
});


test('lagging THORNode fallback cannot replace current state or renew its freshness', async () => {
  const first = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async path => path === '/thorchain/lastblock' ? [{ chain: 'BTC', thorchain: 27957812 }] : payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({}),
    fetchBifrostScannerInfo: async () => scannerPayload()
  });
  const lagging = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 300001),
    previousSnapshot: first,
    fetchThorchain: async path => path === '/thorchain/lastblock' ? [{ chain: 'BTC', thorchain: 27943798 }] : path === '/thorchain/mimir' ? { HALTTRADING: 1 } : payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({}),
    fetchBifrostScannerInfo: async () => scannerPayload()
  });
  assert.equal(lagging.stale, true);
  assert.deepEqual(lagging.lastblock, first.lastblock);
  assert.deepEqual(lagging.mimir, first.mimir, 'other state from the lagging node is also untrustworthy');
  assert.equal(lagging.field_meta.lastblock.fetched_at, first.field_meta.lastblock.fetched_at);
});

test('durable chain head rejects a lagging source even when the previous snapshot was already behind', async () => {
  const sourceHeight = 27943798;
  const fetchThorchain = async path => path === '/thorchain/lastblock'
    ? [{ chain: 'BTC', thorchain: sourceHeight }]
    : payloadFor(path);
  const dependencies = {
    fetchThorchain,
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({}),
    fetchBifrostScannerInfo: async () => scannerPayload()
  };
  const previous = await buildThorNodeCoreSnapshot({ now: () => START, ...dependencies });
  const rejected = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 15001),
    previousSnapshot: previous,
    loadLatestChainHead: async () => ({ height: 27957812 }),
    ...dependencies
  });
  assert.equal(rejected.stale, true);
  assert.match(rejected.errors.lastblock, /behind the known chain head/);
  assert.equal(rejected.field_meta.mimir.status, 'reused');
  assert.equal(rejected.field_meta.mimir.fetched_at, previous.field_meta.mimir.fetched_at);
});

test('same-height responses remain valid during a real chain stall', async () => {
  const dependencies = {
    fetchThorchain: async path => payloadFor(path),
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({}),
    fetchBifrostScannerInfo: async () => scannerPayload(),
    loadLatestChainHead: async () => ({ height: 27957812, time: START.toISOString() })
  };
  const previous = await buildThorNodeCoreSnapshot({ now: () => START, ...dependencies });
  const current = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 3600000),
    previousSnapshot: previous,
    ...dependencies
  });
  assert.equal(current.stale, false);
  assert.equal(current.field_meta.lastblock.status, 'fresh');
});

test('current THORNode source is selected before reading other state and pins subsequent requests', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const laggingBase = 'https://lagging.example';
  const currentBase = 'https://current.example';
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    calls.push({ base: request.origin, path: request.pathname });
    const value = request.pathname === '/thorchain/lastblock'
      ? [{ chain: 'BTC', thorchain: request.origin === laggingBase ? 27943798 : 27957812 }]
      : payloadFor(`${request.pathname}${request.search}`);
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const current = await buildThorNodeCoreSnapshot({
      now: () => START,
      thornodeBases: [laggingBase, currentBase],
      sharedCooldown: false,
      loadLatestChainHead: async () => ({ height: 27957812 }),
      fetchMidgardChurns: async () => [],
      fetchMidgardNetwork: async () => ({}),
      fetchBifrostScannerInfo: async () => scannerPayload()
    });
    assert.equal(current.stale, false);
    assert.equal(current.lastblock[0].thorchain, 27957812);
    assert.deepEqual(calls.filter(call => call.base === laggingBase), [
      { base: laggingBase, path: '/thorchain/lastblock' }
    ]);
    assert.ok(calls.some(call => call.base === currentBase && call.path === '/thorchain/mimir'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('field failures on the verified source cannot fall back to an unverified source', async () => {
  const dependencies = {
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({}),
    fetchBifrostScannerInfo: async () => scannerPayload()
  };
  const previous = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async path => payloadFor(path),
    ...dependencies
  });
  const originalFetch = globalThis.fetch;
  const primaryBase = 'https://current.example';
  const fallbackBase = 'https://lagging.example';
  const calls = [];
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    calls.push(request.origin);
    if (request.pathname === '/thorchain/mimir') return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify(payloadFor(`${request.pathname}${request.search}`)), {
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const current = await buildThorNodeCoreSnapshot({
      now: () => new Date(START.getTime() + 60001),
      previousSnapshot: previous,
      thornodeBases: [primaryBase, fallbackBase],
      sharedCooldown: false,
      ...dependencies
    });
    assert.equal(current.field_meta.mimir.status, 'reused');
    assert.equal(current.field_meta.mimir.fetched_at, previous.field_meta.mimir.fetched_at);
    assert.deepEqual(current.mimir, previous.mimir);
    assert.ok(calls.length > 1);
    assert.ok(calls.every(base => base === primaryBase));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normal RPC head advances preserve field cadences and allow two blocks of REST skew', async () => {
  const dependencies = {
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({}),
    fetchBifrostScannerInfo: async () => scannerPayload()
  };
  const previous = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async path => payloadFor(path),
    ...dependencies
  });
  const calls = [];
  const current = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 15001),
    previousSnapshot: previous,
    loadLatestChainHead: async () => ({ height: 27957815 }),
    fetchThorchain: async path => {
      calls.push(path);
      return [{ chain: 'BTC', thorchain: 27957813 }];
    },
    ...dependencies
  });
  assert.equal(current.stale, false);
  assert.deepEqual(calls, ['/thorchain/lastblock']);
  assert.equal(current.field_meta.mimir.status, 'cached');
});

test('schema upgrade refreshes all previously unverified THORNode state immediately', async () => {
  const dependencies = {
    fetchMidgardChurns: async () => [],
    fetchMidgardNetwork: async () => ({}),
    fetchBifrostScannerInfo: async () => scannerPayload()
  };
  const previous = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async path => payloadFor(path),
    ...dependencies
  });
  previous.schema_version = 3;
  previous.mimir = { HALTTRADING: 1 };
  const calls = [];
  const current = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 1),
    previousSnapshot: previous,
    fetchThorchain: async path => {
      calls.push(path);
      return payloadFor(path);
    },
    ...dependencies
  });
  assert.equal(current.stale, false);
  assert.equal(current.mimir.HALTTRADING, 0);
  assert.equal(current.field_meta.constants.status, 'fresh');
  assert.equal(calls.length, THORNODE_CORE_FIELDS.filter(field => field.provider === 'thornode').length);
});
