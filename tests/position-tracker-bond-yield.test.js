import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { planBondYield } from '../src/lib/position-tracker/memos.js';
import { buildBondRows } from '../src/lib/position-tracker/model.js';
import { bondYieldBps, bondYieldGate, bondYieldTarget, loadBondYieldGate, loadBondYieldReview, readBondYieldConfig, validateBondYieldReview } from '../src/lib/position-tracker/bond-yield.js';

const OWNER = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const TARGET = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const NODE = 'thor100m5hh9qayap0edmvl9h8er4z6uesnfazjmefg';
const MODULE = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt';
const constants = { int_64_values: { BondYieldEnabled: 0 } };
const node = { node_address: NODE, status: 'Active', bond_providers: { providers: [{ bond_address: OWNER, bond: '200000000', bps: 2500, payout_target: TARGET }] } };
const enabled = { version: { current: '3.21.0' }, mimir: { BONDYIELDENABLED: 1 }, constants };
const review = { node, owner: OWNER, signer: OWNER, gates: bondYieldGate(enabled), bps: 4000, target: TARGET };

test('bond yield memos configure exact percentages with a zero-value MsgDeposit', () => {
  const plan = planBondYield({ nodeAddress: NODE, percent: '40.25', payoutTarget: TARGET });
  assert.equal(plan.memo, `BONDYIELD:${NODE}:4025:${TARGET}`);
  assert.equal(plan.amount, '0');
  assert.equal(plan.asset, 'THOR.RUNE');
  assert.equal(plan.chain, 'THOR');
  assert.equal(plan.route, 'thor-deposit');
  assert.equal(planBondYield({ nodeAddress: NODE, percent: 100 }).memo, `BONDYIELD:${NODE}:10000`);
  assert.equal(planBondYield({ nodeAddress: NODE, percent: '0', payoutTarget: 'invalid:ignored' }).memo, `BONDYIELD:${NODE}:0`);
  assert.equal(planBondYield({ nodeAddress: NODE, percent: 1, payoutTarget: 'Yield_Name' }).memo, `BONDYIELD:${NODE}:100:yield_name`);
});

test('payout percentages reject rounding, exponent syntax and out-of-range input', () => {
  for (const value of ['', null, -1, 100.01, '0.001', '1e2', 'NaN', Infinity, '25:100']) assert.throws(() => bondYieldBps(value));
  assert.equal(bondYieldBps('0.01'), 1);
  assert.equal(bondYieldBps('00.50'), 50);
});

test('payout destinations validate checksums, mainnet, module accounts and memo delimiters', () => {
  assert.equal(bondYieldTarget(TARGET.toUpperCase()), TARGET);
  for (const target of [`${TARGET.slice(0, -1)}q`, 'cosmos1j722pvfah52yrw904cem4mn67ravzrhu5yvp5h', MODULE, 'name:10000', 'bad name', 'x'.repeat(31)]) assert.throws(() => bondYieldTarget(target));
  assert.throws(() => planBondYield({ nodeAddress: `${NODE.slice(0, -1)}q`, percent: 50 }));
});

test('activation uses current network version and effective Mimir over compiled defaults', () => {
  assert.equal(bondYieldGate(enabled).bondYieldEnabled, true);
  assert.equal(bondYieldGate({ ...enabled, version: { current: '3.20.3', next: '3.21.0' } }).bondYieldEnabled, false);
  assert.equal(bondYieldGate({ ...enabled, version: { current: '3.21.0-rc1' } }).bondYieldEnabled, false);
  assert.equal(bondYieldGate({ ...enabled, mimir: { BONDYIELDENABLED: 0 }, constants: { int_64_values: { BondYieldEnabled: 1 } } }).bondYieldEnabled, false);
  assert.equal(bondYieldGate({ ...enabled, mimir: { BONDYIELDENABLED: -1 }, constants: { int_64_values: { BondYieldEnabled: 1 } } }).bondYieldEnabled, true);
  assert.equal(bondYieldGate({ ...enabled, mimir: {}, constants }).bondYieldEnabled, false);
  for (const field of ['version', 'mimir']) assert.equal(bondYieldGate({ ...enabled, [field]: null }).bondYieldEnabled, false);
  assert.equal(bondYieldGate({ ...enabled, mimir: {}, constants: null }).bondYieldEnabled, false);
  assert.equal(bondYieldGate({ ...enabled, mimir: { BONDYIELDENABLED: 'bad' }, constants: { int_64_values: { BondYieldEnabled: 1 } } }).bondYieldEnabled, false);
});

test('bond rows expose per-provider configuration without changing bond principal', () => {
  const rows = buildBondRows({ nodes: [node], addresses: [OWNER] });
  assert.deepEqual(rows[0].bondYield, { bps: 2500, target: TARGET });
  assert.equal(rows[0].bond, 2);
  assert.deepEqual(readBondYieldConfig(), { bps: 0, target: '' });
  assert.equal(readBondYieldConfig({ bps: 10001 }).bps, null);
});

test('payout review requires the exact provider wallet, membership and eligible node state', () => {
  assert.deepEqual(validateBondYieldReview(review), { destination: TARGET, asset: 'RUNE' });
  for (const status of ['Active', 'Standby', 'Ready']) assert.doesNotThrow(() => validateBondYieldReview({ ...review, node: { ...node, status } }));
  for (const status of ['Disabled', 'Whitelisted', 'Unknown', '']) assert.throws(() => validateBondYieldReview({ ...review, node: { ...node, status } }));
  assert.throws(() => validateBondYieldReview({ ...review, signer: TARGET }), /provider wallet/);
  assert.throws(() => validateBondYieldReview({ ...review, node: { ...node, bond_providers: { providers: [] } } }), /not a bond provider/);
  assert.throws(() => validateBondYieldReview({ ...review, gates: { ...review.gates, globalHalt: true } }), /halted/);
});

test('empty nonzero destinations preserve the saved target; provider selection explicitly replaces it', () => {
  assert.equal(validateBondYieldReview({ ...review, target: '' }).destination, TARGET);
  const plan = planBondYield({ nodeAddress: NODE, percent: 50, payoutTarget: OWNER });
  assert.equal(plan.memo, `BONDYIELD:${NODE}:5000:${OWNER}`);
  assert.equal(validateBondYieldReview({ ...review, target: plan.payoutTarget }).destination, OWNER);
  assert.deepEqual(validateBondYieldReview({ ...review, bps: 0, target: 'stale:name' }), { destination: '', asset: 'RUNE' });
});

test('THORName ownership, THOR alias and preferred-asset routes are checked', () => {
  const named = { ...review, target: 'yieldname', thorname: { name: 'yieldname', owner: OWNER, aliases: [{ chain: 'THOR', address: TARGET }] } };
  assert.equal(validateBondYieldReview(named).destination, TARGET);
  assert.equal(validateBondYieldReview({ ...named, thorname: { ...named.thorname, aliases: [] } }).destination, OWNER);
  assert.deepEqual(validateBondYieldReview({ ...named, thorname: { ...named.thorname, preferred_asset: 'BTC.BTC' } }), { destination: 'yieldname', asset: 'BTC.BTC', collector: true });
  assert.throws(() => validateBondYieldReview({ ...named, thorname: null }), /not found/);
  assert.throws(() => validateBondYieldReview({ ...named, thorname: { ...named.thorname, owner: TARGET } }), /must be owned/);
  assert.throws(() => validateBondYieldReview({ ...named, thorname: { ...named.thorname, aliases: [{ chain: 'THOR', address: MODULE }] } }), /network module/);
});

function clientFixture(overrides = {}) {
  const calls = [];
  const values = {
    '/thorchain/version': enabled.version, '/thorchain/mimir': enabled.mimir, '/thorchain/constants': constants,
    [`/thorchain/node/${NODE}`]: node,
    '/thorchain/thorname/yieldname': { name: 'yieldname', owner: OWNER, aliases: [] },
    ...overrides
  };
  return { calls, fetch: async (url, options) => {
    calls.push({ url, options });
    if (!(url in values) || values[url] instanceof Error) throw values[url] || new Error(`Unexpected ${url}`);
    return values[url];
  } };
}

test('fresh payout checks bypass both caches and do not request a signature or broadcast', async () => {
  const client = clientFixture();
  const result = await loadBondYieldReview(client, { plan: planBondYield({ nodeAddress: NODE, percent: 40, payoutTarget: 'yieldname' }), owner: OWNER, signer: OWNER });
  assert.equal(result.destination, OWNER);
  assert.equal(client.calls.length, 5);
  for (const call of client.calls) assert.deepEqual(call.options, { cache: false, coreSnapshot: false });
});

test('refreshing after a settings transaction reads current provider state instead of the dashboard snapshot', async () => {
  const source = (await readFile(new URL('../src/lib/position-tracker/data.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  let reads = 0;
  const loader = runInNewContext(`${source}\n({ loadNodes })`, {
    booneToolsApi: { get: () => { throw new Error('Must bypass the snapshot'); } },
    thornode: { fetch: async (url, options) => {
      assert.equal(url, '/thorchain/nodes');
      assert.equal(options.cache, false);
      assert.equal(options.coreSnapshot, false);
      reads++;
      return [node];
    } }
  });
  assert.equal((await loader.loadNodes({ fresh: true }))[0], node);
  assert.equal(reads, 1);
});

test('network failures and deactivation between review and signing block execution', async () => {
  const client = clientFixture({ '/thorchain/mimir': new Error('offline') });
  assert.equal((await loadBondYieldGate(client)).bondYieldEnabled, false);
  await assert.rejects(loadBondYieldReview(client, { plan: planBondYield({ nodeAddress: NODE, percent: 50 }), owner: OWNER, signer: OWNER }), /activation/);
  const deactivated = clientFixture({ '/thorchain/mimir': { BONDYIELDENABLED: 0 } });
  await assert.rejects(loadBondYieldReview(deactivated, { plan: planBondYield({ nodeAddress: NODE, percent: 0 }), owner: OWNER, signer: OWNER }), /not enabled/);
  await assert.rejects(loadBondYieldReview(clientFixture({ [`/thorchain/node/${NODE}`]: { ...node, node_address: TARGET } }), { plan: planBondYield({ nodeAddress: NODE, percent: 50 }), owner: OWNER, signer: OWNER }), /selected node/);
});

test('signing rechecks activation and destination, and never opens a wallet on a failed check', async () => {
  const source = await readFile(new URL('../src/lib/position-tracker/ActionModal.svelte', import.meta.url), 'utf8');
  const sign = source.match(/  async function sign\(\) \{[\s\S]*?\n  \}/)[0].replace("await import('./actions.js')", 'fakeActions');
  const plan = planBondYield({ nodeAddress: NODE, percent: 50, payoutTarget: TARGET });
  for (const outcome of [new Error('Bond yield is not enabled'), { destination: OWNER, asset: 'RUNE' }, { destination: TARGET, asset: 'RUNE' }]) {
    let executions = 0, checks = 0;
    const state = runInNewContext(`${sign}\n({ sign, state: () => ({ phase, results }) })`, {
      canSign: true, reviews: [{ plan, signer: { address: OWNER } }], phase: 'form', signError: '', results: [],
      spec: { owner: OWNER }, thornode: {}, yieldDestination: { destination: TARGET, asset: 'RUNE' },
      fakeActions: { executePlan: async () => { executions++; return 'test-hash'; } }, dispatch: () => {},
      loadBondYieldReview: async () => { checks++; if (outcome instanceof Error) throw outcome; return outcome; }
    });
    await state.sign();
    assert.equal(checks, 1);
    assert.equal(executions, outcome.destination === TARGET ? 1 : 0);
    assert.equal(state.state().results[0].status, executions ? 'sent' : 'failed');
  }
});

test('a payout check cannot approve a form that changed while the network request was in flight', async () => {
  const source = await readFile(new URL('../src/lib/position-tracker/ActionModal.svelte', import.meta.url), 'utf8');
  const check = source.match(/  async function checkYield\(\) \{[\s\S]*?\n  \}/)[0];
  let settle;
  const state = runInNewContext(`${check}\n({ checkYield, change: () => yieldCheckKey = 'changed', state: () => ({ yieldDestination, yieldCheckedKey, yieldChecking }) })`, {
    plans: [planBondYield({ nodeAddress: NODE, percent: 50 })], signerKeys: {}, accounts: [], signerFor: () => ({ address: OWNER }),
    yieldRequestId: 0, yieldCheckKey: 'original', yieldChecking: false, yieldCheckError: '', yieldCheckedKey: '', yieldDestination: null,
    spec: { owner: OWNER }, thornode: {}, loadBondYieldReview: () => new Promise((resolve) => { settle = resolve; })
  });
  const pending = state.checkYield();
  state.change();
  settle({ destination: TARGET, asset: 'RUNE' });
  await pending;
  assert.equal(state.state().yieldDestination, null);
  assert.equal(state.state().yieldCheckedKey, '');
  assert.equal(state.state().yieldChecking, false);
});

test('the THORNode client bypass option reaches providers without reading the dashboard snapshot', async () => {
  const source = (await readFile(new URL('../src/lib/api/thornode.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/import\.meta\.env\?\.DEV/g, 'false').replace(/^export /gm, '');
  let snapshotReads = 0, providerReads = 0;
  const client = runInNewContext(`${source}\nnew ThorNodeClient()`, {
    LIQUIFY_THORNODE: 'https://example.test', NATIVESWAP_THORNODE: 'https://fallback.test',
    resolveCoreSnapshotPath: async () => { snapshotReads++; return { handled: true, value: { cached: true } }; },
    requestFromProviders: async () => { providerReads++; return { fresh: true }; }, browserProviderHeaders: () => ({}),
    fromBaseUnit: (n) => n / 1e8
  });
  assert.equal((await client.fetch('/thorchain/mimir', { cache: false, coreSnapshot: false })).fresh, true);
  assert.equal(snapshotReads, 0);
  assert.equal(providerReads, 1);
  assert.equal((await client.fetch('/thorchain/mimir', { cache: false })).cached, true);
  assert.equal(snapshotReads, 1);
});

test('payout modal reviews a zero-value configuration and blocks signing before verification', async () => {
  const url = new URL('../src/lib/position-tracker/ActionModal.svelte', import.meta.url);
  const source = (await readFile(url, 'utf8')).replace("import { thornode } from '../api/index.js';", 'const thornode = {};');
  const { js } = compile(source, { generate: 'server', filename: url.pathname });
  const code = js.code.replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => `from ${quote}${specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)}${quote}`);
  const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const html = render(Component, { props: {
    spec: { kind: 'bond-yield', nodeAddress: NODE, owner: OWNER, bondYield: { bps: 4000, target: TARGET } },
    accounts: [{ provider: 'TEST', network: 'THOR', address: OWNER }], gates: review.gates
  } }).body;
  assert.match(html, new RegExp(`BONDYIELD:${NODE}:4000:${TARGET}`));
  assert.match(html, /0 THOR.RUNE/);
  assert.match(html, /40% paid out · 60% rebonded/);
  assert.match(html, /Check payout settings before signing/);
  assert.match(html, /class="bracket-btn primary" disabled/);
});
