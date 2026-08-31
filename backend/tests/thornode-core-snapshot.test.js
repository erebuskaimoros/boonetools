import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THORNODE_CORE_FIELDS,
  buildThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from '../src/shared/thornode-core-snapshot.js';

const START = new Date('2026-07-27T12:00:00.000Z');

function payloadFor(path) {
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
