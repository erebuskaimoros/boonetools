import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReusableBondNode } from '../src/lib/bond-tracker/shared-nodes.js';

const node = { node_address: 'thor-node', current_award: '0', bond_providers: { node_operator_fee: '100', providers: [] } };
const nowMs = Date.parse('2026-09-02T10:00:00Z');
test('reuse complete node data from a fresh successful shared observation', () => {
  assert.equal(selectReusableBondNode([node], 'thor-node', { fetched_at: new Date(nowMs - 1000).toISOString(), status: 'cached' }, nowMs), node);
});
test('stale, failed, future-dated, or incomplete shared nodes need a direct refresh', () => {
  for (const meta of [{}, { fetched_at: new Date(nowMs - 301000).toISOString(), status: 'fresh' }, { fetched_at: new Date(nowMs).toISOString(), status: 'reused' }, { fetched_at: new Date(nowMs + 1000).toISOString(), status: 'fresh' }]) {
    assert.equal(selectReusableBondNode([node], 'thor-node', meta, nowMs), null);
  }
  assert.equal(selectReusableBondNode([{ ...node, current_award: undefined }], 'thor-node', { fetched_at: new Date(nowMs).toISOString(), status: 'fresh' }, nowMs), null);
});
