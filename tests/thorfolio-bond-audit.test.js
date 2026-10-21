import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadTrackedAddresses, STORAGE_KEY } from '../src/lib/position-tracker/addresses.js';
import * as addresses from '../src/lib/position-tracker/addresses.js';
import { selectReusableBondNode } from '../src/lib/bond-tracker/shared-nodes.js';

const A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';

test('an explicit portfolio URL displays exactly its addresses even with another saved portfolio', () => {
  const storage = { getItem: (key) => key === STORAGE_KEY ? JSON.stringify([
    { address: A, label: 'saved A' }, { address: B, label: 'saved B' }
  ]) : null };
  const selected = loadTrackedAddresses({ storage, search: `?addresses=${B}&tab=bond` });
  assert.deepEqual(selected.map((entry) => entry.address), [B]);
  assert.equal(selected[0].label, 'saved B');
});

test('random bond lookup selects a funded provider on an active node', () => {
  assert.equal(typeof addresses.pickRandomBondAddress, 'function');
  const nodes = [
    { status: 'Standby', bond_providers: { providers: [{ bond_address: A, bond: '900000000' }] } },
    { status: 'Active', bond_providers: { providers: [{ bond_address: A, bond: '0' }, { bond_address: B, bond: '200000000' }] } }
  ];
  assert.equal(addresses.pickRandomBondAddress(nodes, () => 0), B);
  assert.equal(addresses.pickRandomBondAddress([], () => 0), '');
});

test('random bond lookup ignores invalid addresses, dust and duplicate providers', () => {
  assert.equal(typeof addresses.pickRandomBondAddress, 'function');
  const providers = [
    { bond_address: A, bond: '100000000' },
    { bond_address: 'bad-address', bond: '900000000' },
    { bond_address: A, bond: '200000000' },
    { bond_address: A, bond: '300000000' },
    { bond_address: B, bond: '400000000' }
  ];
  const nodes = [{ status: 'Active', bond_providers: { providers } }];
  assert.equal(addresses.pickRandomBondAddress(nodes, () => 0.5), B);
  assert.equal(addresses.pickRandomBondAddress([{ status: 'Active', bond_providers: { providers: providers.slice(0, 2) } }]), '');
  assert.equal(addresses.pickRandomBondAddress([null, {}, { status: 'Active' }, { status: 'Active', bond_providers: { providers: null } }, { status: 'Active', bond_providers: { providers: [null] } }]), '');
});

test('an empty or invalid explicit portfolio never silently loads saved addresses', () => {
  const storage = { getItem: () => JSON.stringify([{ address: A }]) };
  assert.deepEqual(loadTrackedAddresses({ storage, search: '?addresses=' }), []);
  assert.deepEqual(loadTrackedAddresses({ storage, search: '?addresses=invalid' }), []);
});

const trackerSource = readFileSync(new URL('../src/lib/PositionTracker.svelte', import.meta.url), 'utf8');
const randomAction = trackerSource.match(/  async function trackRandomBondProvider\(\) \{[\s\S]*?\n  \}/)?.[0];

function randomActionHarness(tracked, selectedAddress) {
  return runInNewContext(`
    let tracked = initialTracked, randomLoading = false, addressFeedback = '', focusAddress = '', activeTab = '';
    let persisted = 0, refreshed = 0;
    function persist(list) { tracked = list; persisted += 1; }
    function selectTab(tab) { activeTab = tab; }
    async function refresh() { refreshed += 1; }
    ${randomAction}
    ({ run: trackRandomBondProvider, state: () => ({ tracked, randomLoading, addressFeedback, focusAddress, activeTab, persisted, refreshed }) })
  `, {
    initialTracked: tracked,
    loadNodes: async () => [],
    pickRandomBondAddress: () => selectedAddress,
    addAddresses: addresses.addAddresses,
    MAX_TRACKED_ADDRESSES: addresses.MAX_TRACKED_ADDRESSES
  });
}

test('random provider action focuses an already tracked address without replacing the portfolio', async () => {
  const tracked = [{ address: A, label: 'saved A' }, { address: B, label: 'saved B' }];
  const action = randomActionHarness(tracked, B);
  await action.run();
  const result = action.state();
  assert.equal(result.tracked, tracked);
  assert.equal(result.persisted, 0);
  assert.equal(result.focusAddress, B);
  assert.equal(result.activeTab, 'bond');
  assert.equal(result.refreshed, 1);
});

test('random provider action retains existing addresses and reports empty or full-list failures', async () => {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const full = [...alphabet.slice(0, 25)].map((letter) => ({ address: `thor1${'q'.repeat(37)}${letter}`, label: letter }));
  for (const [tracked, candidate, expectedError] of [[full, B, /limit is 25/], [[{ address: A }], '', /No active bond providers/]]) {
    const action = randomActionHarness(tracked, candidate);
    await action.run();
    const result = action.state();
    assert.equal(result.tracked, tracked);
    assert.equal(result.persisted, 0);
    assert.equal(result.refreshed, 0);
    assert.equal(result.randomLoading, false);
    assert.match(result.addressFeedback, expectedError);
  }
  const action = randomActionHarness([{ address: A, label: 'saved A' }], B);
  await action.run();
  assert.deepEqual(action.state().tracked.map((entry) => [entry.address, entry.label]), [[A, 'saved A'], [B, '']]);
  assert.equal(action.state().persisted, 1);
});

const dataSource = readFileSync(new URL('../src/lib/position-tracker/data.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

test('current bonds reject stale shared snapshots and use live nodes', async () => {
  const stale = { node_address: 'stale', current_award: '1', bond_providers: { providers: [], node_operator_fee: '1000' } };
  const live = { ...stale, node_address: 'live' };
  let calls = 0;
  const loader = runInNewContext(`${dataSource}\n({ loadNodes })`, {
    selectReusableBondNode,
    booneToolsApi: { get: async () => ({ value: [stale], stale: true, field_meta: { status: 'cached', fetched_at: new Date(Date.now() - 600000).toISOString() } }) },
    getNodes: async () => { calls += 1; return [live]; }
  });
  const result = await loader.loadNodes();
  assert.equal(result[0].node_address, 'live');
  assert.equal(calls, 1);
});

test('current bonds reuse fresh complete snapshots and reject expired or incomplete rows', async () => {
  const node = { node_address: A, current_award: '1', bond_providers: { providers: [], node_operator_fee: '1000' } };
  const currentMeta = { status: 'cached', fetched_at: new Date().toISOString() };
  for (const snapshot of [
    { value: [node], field_meta: currentMeta },
    { value: [node], field_meta: { ...currentMeta, fetched_at: new Date(Date.now() - 600000).toISOString() } },
    { value: [{ ...node, current_award: null, bond_providers: { ...node.bond_providers, providers: [{ bond_address: B, bond: '200000000' }] } }], field_meta: currentMeta },
    { value: [node], field_meta: {} }
  ]) {
    let calls = 0;
    const loader = runInNewContext(`${dataSource}\n({ loadNodes })`, {
      selectReusableBondNode,
      booneToolsApi: { get: async () => snapshot },
      getNodes: async () => { calls += 1; return [{ ...node, node_address: 'live' }]; }
    });
    const result = await loader.loadNodes();
    const reusable = snapshot.field_meta === currentMeta && snapshot.value[0] === node;
    assert.equal(calls, reusable ? 0 : 1);
    assert.equal(result[0].node_address, reusable ? A : 'live');
  }
});

test('fresh standby nodes with null providers are valid without current awards', async () => {
  const node = { node_address: A, status: 'Standby', bond_providers: { providers: null, node_operator_fee: '2000' } };
  const loader = runInNewContext(`${dataSource}\n({ loadNodes })`, {
    selectReusableBondNode,
    booneToolsApi: { get: async () => ({ value: [node], field_meta: { status: 'fresh', fetched_at: new Date().toISOString() } }) },
    getNodes: async () => { throw new Error('An empty provider list should not force another network request'); }
  });
  const result = await loader.loadNodes();
  assert.equal(result[0], node);
});
