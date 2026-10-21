import assert from 'node:assert/strict';
import test from 'node:test';
import { backfillOperatorFees, loadChurnOperatorFee, parseChurnOperatorFees } from '../src/shared/bond-operator-fees.js';

const bond = (type, node, address = '', amount = '100', id = '') => ({ type: 'bond', attributes:
  Object.entries({ bond_type: type, node_address: node, bond_address: address, amount, id })
    .map(([key, value]) => ({ key, value })) });
const reward = (node) => bond('bond_reward', node);
const paid = (node, address, amount) => bond('bond_returned', node, address, amount);
const block = (events) => ({ result: { height: '100', finalize_block_events: events } });

// Include an ordinary unbond, unrelated return, and subsequent provider yield:
// only the reward's immediately following empty-tx return belongs to its operator.
const events = [reward('node1'), paid('node1', 'operator', '9007199254740993'),
  paid('node1', 'provider', '999'), bond('bond_returned', 'node1', 'operator', '999', 'ABC'),
  reward('node2'), paid('node2', 'operator', '7'), reward('node3'), paid('node3', 'other', '50')];

test('extracts paid operator fees without counting unbonds or provider yield', () => {
  assert.deepEqual(parseChurnOperatorFees(block(events), 100).payouts, [
    { node: 'node1', address: 'operator', amount: '9007199254740993' },
    { node: 'node2', address: 'operator', amount: '7' },
    { node: 'node3', address: 'other', amount: '50' }
  ]);
});

test('supports base64 event attributes and legacy end-block envelopes', () => {
  const encoded = events.map((event) => ({ ...event, attributes: event.attributes.map(({ key, value }) => ({
    key: Buffer.from(key).toString('base64'), value: Buffer.from(value).toString('base64')
  })) }));
  assert.deepEqual(parseChurnOperatorFees({ result: { height: '100', begin_block_events: null, end_block_events: encoded } }, 100), parseChurnOperatorFees(block(events), 100));
});

test('rejects wrong heights, missing events, ambiguous returns and duplicate payouts', () => {
  for (const payload of [{ result: { height: '101', finalize_block_events: events } },
    { result: { height: '100' } }, block([]), block([reward('node1'), paid('node1', '', '5')]),
    block([reward('node1'), paid('node1', 'operator', '-1')]), block([...events, reward('node1')])]) {
    assert.throws(() => parseChurnOperatorFees(payload, 100));
  }
});

test('shares one immutable churn observation across addresses and sums only scoped nodes exactly', async () => {
  let reads = 0;
  let cached;
  const options = {
    loadNode: async (node, height) => {
      assert.equal(height, 99);
      return { bond_providers: { node_operator_fee: '1000', providers: [{ bond_address: node === 'node3' ? 'other' : 'operator' }] } };
    },
    acquireCached: async (_client, spec) => {
      assert.equal(spec.immutable, true);
      if (!cached) cached = { payload: await spec.load({}) };
      assert.ok(spec.validate(cached.payload));
      return cached;
    },
    fetchThorchainRpc: async (route, params, options) => {
      assert.equal(route, '/block_results'); assert.equal(params.height, '100');
      assert.equal(options.sharedCooldown, true); reads++; return block(events);
    }
  };
  assert.equal(await loadChurnOperatorFee('operator', ['node1', 'node2', 'node2'], 100, options), '9007199254741000');
  assert.equal(await loadChurnOperatorFee('operator', ['node2'], 100, options), '7');
  assert.equal(await loadChurnOperatorFee('provider', ['node1'], 100, options), '0');
  assert.equal(reads, 1);
});

test('metadata backfill is bounded, newest first and preserves existing accounting and verified zeroes', async () => {
  const rows = [1, 2, 3].map((height) => ({ churn_height: height, rune_stack: 100, user_bond: 90, operator_fee: height === 2 ? '0' : null }));
  const seen = [];
  const result = await backfillOperatorFees('operator', ['node'], rows, { limit: 1,
    loadFee: async (_address, _nodes, height) => { seen.push(height); return '10'; } });
  assert.deepEqual(seen, [3]); assert.equal(result.complete, false);
  assert.deepEqual(rows.map((row) => row.operator_fee), [null, '0', '10']);
  assert.ok(rows.every((row) => row.rune_stack === 100 && row.user_bond === 90));
  const failed = await backfillOperatorFees('operator', ['node'], rows, {
    loadFee: async () => { throw new Error('429'); } });
  assert.equal(failed.complete, false); assert.equal(rows[0].operator_fee, null);
});

test('a paired provider payout or zero-fee operator yield cannot masquerade as an operator fee', async () => {
  for (const node of [
    { node_operator_address: 'other', bond_providers: { node_operator_fee: '1000' } },
    { node_operator_address: 'operator', bond_providers: { node_operator_fee: '0' } }
  ]) {
    assert.equal(await loadChurnOperatorFee('operator', ['node1'], 100, {
      acquireCached: async () => ({ payload: { height: 100, payouts: [{ node: 'node1', address: 'operator', amount: '50' }] } }),
      loadNode: async () => node
    }), '0');
  }
  await assert.rejects(loadChurnOperatorFee('operator', ['node1'], 100, {
    acquireCached: async () => ({ payload: { height: 100, payouts: [{ node: 'node1', address: 'operator', amount: '50' }] } }),
    loadNode: async () => ({ bond_providers: { node_operator_fee: '1000' } })
  }), /identity unavailable/);
});
