import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';

const source = readFileSync(new URL('../src/lib/BondTrackerV2.svelte', import.meta.url), 'utf8');
const script = parse(source).instance.content;
// Exercise the component's actual async handlers without a DOM or real providers.
// Rendering and store reactions are verified separately in the browser.
const handlers = script.body
  .filter((statement) => statement.type !== 'ImportDeclaration' && statement.type !== 'LabeledStatement')
  .map((statement) => source.slice(statement.start, statement.end))
  .join('\n')
  .replaceAll('import.meta.env', '({ BASE_URL: "/" })');

function createTracker({ savedAddress = '', search = '', getSnapshot, getNodes, getHistory } = {}) {
  const storage = new Map(savedAddress ? [['bond_tracker_address', savedAddress]] : []);
  const calls = [];
  const location = new URL(`https://boone.tools/bond-tracker${search}`);
  const tracker = runInNewContext(`${handlers}\n({
    fetchBondData, fetchBondHistory, updateAddressesFromURL, switchAddress,
    submit(address) {
      my_bond_address = address;
      handleSubmit({ preventDefault() {} });
    },
    seedPreviousPosition() {
      my_bond_address = 'thor1empty';
      my_bond = 500e8; my_award = 5e8; APY = 0.12;
      node_address = 'thor1oldnode'; nodeAddressSuffix = 'node';
      bondNodes = [{ address: node_address, bond: my_bond }];
      isMultiNode = true; totalBond = my_bond; totalAward = my_award;
      aggregateAPY = APY; nodeOperatorFee = 0.1; bondvaluebtc = 0.2;
      historyLoaded = true; churnHistory = [{ runeStack: 505e8 }];
    },
    state() { return {
      my_bond_address, my_bond, my_award, APY, node_address, bondNodes,
      totalBond, totalAward, aggregateAPY, nodeOperatorFee, bondvaluebtc,
      isLoading, showContent, showData, historyLoading, historyLoaded, churnHistory,
      noCurrentBonds, bondDataError
    }; }
  })`, {
    URL, URLSearchParams,
    window: {
      location,
      history: {
        pushState(_state, _title, url) { location.href = String(url); },
        replaceState(_state, _title, url) { location.href = String(url); }
      }
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    booneToolsApi: { async get(route) {
      calls.push(route);
      if (route === '/network-snapshot') return getSnapshot ? getSnapshot() : { value: [], field_meta: {} };
      // A queued history request must never hold a known-empty current position open.
      if (route === '/bond-history') return getHistory ? getHistory() : new Promise(() => {});
      throw new Error(`Unexpected request: ${route}`);
    } },
    getNodes: getNodes || (async () => { throw new Error('Node provider unavailable'); }),
    getAddressSuffix: (address) => address.slice(-4),
    get: () => 'USD', currentCurrency: {},
    onMount() {}, onDestroy() {},
    setTimeout(callback, delay) { if (delay < 1000) callback(); return 0; },
    clearTimeout() {},
    console: { error() {} }
  });
  return { tracker, calls, storage, location };
}

test('an address with no current bonds stays on the form without queuing history', async () => {
  const { tracker, calls, storage, location } = createTracker();
  tracker.submit('thor1empty');
  await new Promise((resolve) => setImmediate(resolve));
  const state = tracker.state();
  assert.equal(state.isLoading, false);
  assert.equal(state.showData, false, 'no-bond results must not mount the dashboard');
  assert.equal(state.my_bond_address, 'thor1empty', 'keep the query editable');
  assert.equal(state.my_bond, 0);
  assert.equal(state.my_award, 0);
  assert.equal(state.historyLoading, false, 'empty addresses must not be stuck loading history');
  assert.equal(state.historyLoaded, false);
  assert.equal(state.churnHistory.length, 0);
  assert.equal(state.noCurrentBonds, true);
  assert.equal(state.bondDataError, null);
  assert.equal(storage.has('bond_tracker_address'), false);
  assert.equal(location.searchParams.has('bond_address'), false);
  assert.deepEqual(calls, ['/network-snapshot']);
});

test('the address form remains visible while checking whether a bond exists', async () => {
  let finishSnapshot;
  const { tracker } = createTracker({
    getSnapshot: () => new Promise((resolve) => { finishSnapshot = resolve; })
  });
  tracker.submit('thor1empty');
  assert.equal(tracker.state().showData, false);
  assert.equal(tracker.state().isLoading, true);
  finishSnapshot({ value: [], field_meta: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tracker.state().showData, false);
  assert.equal(tracker.state().noCurrentBonds, true);
});

test('an empty lookup clears amounts and nodes left by a previous bond position', async () => {
  const { tracker } = createTracker();
  tracker.seedPreviousPosition();
  await tracker.fetchBondData();
  const state = tracker.state();
  for (const field of ['my_bond', 'my_award', 'APY', 'totalBond', 'totalAward', 'aggregateAPY', 'nodeOperatorFee', 'bondvaluebtc']) {
    assert.equal(state[field], 0, `${field} must be zero for the new empty address`);
  }
  assert.equal(state.node_address, '');
  assert.equal(state.bondNodes.length, 0);
  assert.equal(state.churnHistory.length, 0);
});

test('a restored empty address returns to the form and clears persistent auto-load state', async () => {
  const { tracker, storage, location } = createTracker({
    savedAddress: 'thor1empty',
    search: '?bond_address=thor1empty&node_address=thor1oldnode'
  });
  tracker.updateAddressesFromURL();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tracker.state().my_bond_address, 'thor1empty');
  assert.equal(tracker.state().historyLoading, false);
  assert.equal(tracker.state().historyLoaded, false);
  assert.equal(tracker.state().showData, false);
  assert.equal(storage.has('bond_tracker_address'), false);
  assert.equal(location.searchParams.has('bond_address'), false);
  assert.equal(location.searchParams.has('node_address'), false);
});

test('a malformed snapshot and failed fallback show an error instead of a false no-bond result', async () => {
  for (const value of [null, {}, [{ node_address: 'thor1node' }]]) {
    const { tracker, calls } = createTracker({ getSnapshot: async () => ({ value }) });
    await tracker.fetchBondData();
    const state = tracker.state();
    assert.equal(state.isLoading, false);
    assert.equal(state.noCurrentBonds, false);
    assert.ok(state.bondDataError);
    assert.equal(state.historyLoading, false);
    assert.deepEqual(calls, ['/network-snapshot']);
  }
});

test('an unavailable snapshot can still resolve an empty position through the node fallback', async () => {
  const { tracker } = createTracker({
    getSnapshot: async () => { throw new Error('Snapshot unavailable'); },
    getNodes: async () => []
  });
  await tracker.fetchBondData();
  assert.equal(tracker.state().noCurrentBonds, true);
  assert.equal(tracker.state().bondDataError, null);
  assert.equal(tracker.state().historyLoading, false);
});

test('THORNode null provider lists are valid nodes without a provider position', async () => {
  const { tracker } = createTracker({ getSnapshot: async () => ({ value: [{
    node_address: 'thor1standby',
    status: 'Standby',
    bond_providers: { providers: null, node_operator_fee: '2000' }
  }] }) });
  await tracker.fetchBondData();
  assert.equal(tracker.state().noCurrentBonds, true);
  assert.equal(tracker.state().bondDataError, null);
});

test('a request finishing after change address cannot restore the old dashboard', async () => {
  let finishSnapshot;
  const { tracker, calls, storage, location } = createTracker({
    savedAddress: 'thor1empty',
    search: '?bond_address=thor1empty&node_address=thor1oldnode',
    getSnapshot: () => new Promise((resolve) => { finishSnapshot = resolve; })
  });
  const pending = tracker.fetchBondData();
  tracker.switchAddress();
  finishSnapshot({ value: [], field_meta: {} });
  await pending;
  const state = tracker.state();
  assert.equal(state.showData, false);
  assert.equal(state.my_bond_address, '');
  assert.equal(state.noCurrentBonds, false);
  assert.equal(state.historyLoading, false);
  assert.equal(state.historyLoaded, false);
  assert.equal(storage.has('bond_tracker_address'), false);
  assert.equal(location.searchParams.has('bond_address'), false);
  assert.equal(location.searchParams.has('node_address'), false);
  assert.deepEqual(calls, ['/network-snapshot']);
});

test('history finishing after change address cannot replace the new address history state', async () => {
  let finishHistory;
  const { tracker } = createTracker({
    getHistory: () => new Promise((resolve) => { finishHistory = resolve; })
  });
  tracker.seedPreviousPosition();
  const pending = tracker.fetchBondHistory();
  assert.equal(tracker.state().historyLoading, true);
  tracker.switchAddress();
  finishHistory({ history: [{ churn_height: 1, churn_timestamp: 1000, rune_stack: 505e8, rune_price: 1 }] });
  await pending;
  const state = tracker.state();
  assert.equal(state.historyLoaded, false);
  assert.equal(state.historyLoading, false);
  assert.equal(state.churnHistory.length, 0);
});
