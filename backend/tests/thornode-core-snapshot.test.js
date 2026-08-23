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
  if (path === '/thorchain/constants') return { int_64_values: {} };
  return [];
}

test('durable core snapshot staggers fields by their volatility', async () => {
  const firstCalls = [];
  const first = await buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async (path) => {
      firstCalls.push(path);
      return payloadFor(path);
    },
    fetchMidgardChurns: async () => []
  });
  assert.equal(firstCalls.length, THORNODE_CORE_FIELDS.filter((field) => field.provider === 'thornode').length);
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
    fetchMidgardChurns: async () => []
  });
  const failed = await buildThorNodeCoreSnapshot({
    now: () => new Date(START.getTime() + 15_001),
    previousSnapshot: first,
    fetchThorchain: async () => { throw new Error('temporarily blocked'); },
    fetchMidgardChurns: async () => []
  });
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.lastblock, first.lastblock);
  assert.match(failed.warnings.join(' '), /reused last successful value/);
});

test('durable core snapshot refuses a first publication without required THORNode fields', async () => {
  await assert.rejects(() => buildThorNodeCoreSnapshot({
    now: () => START,
    fetchThorchain: async () => { throw new Error('blocked'); },
    fetchMidgardChurns: async () => [{ height: 1 }]
  }), /missing required fields/);
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
