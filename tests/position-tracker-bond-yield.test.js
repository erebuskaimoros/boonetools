import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { planBondYield } from '../src/lib/position-tracker/memos.js';
import { bondYieldNameFields, connectedBondYieldOwner, createBondYieldNameLookup, loadBondYieldName, loadOwnedBondYieldNames } from '../src/lib/position-tracker/bond-yield-names.js';
import { buildBondRows } from '../src/lib/position-tracker/model.js';
import { bondYieldAssetOptions, bondYieldBps, bondYieldGate, bondYieldTarget, loadBondYieldGate, loadBondYieldReview, readBondYieldConfig, recheckBondYieldBeforeSigning, validateBondYieldReview } from '../src/lib/position-tracker/bond-yield.js';
import { bondYieldAssetAddress } from '../src/lib/position-tracker/bond-yield-assets.js';

const OWNER = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const TARGET = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const NODE = 'thor100m5hh9qayap0edmvl9h8er4z6uesnfazjmefg';
const MODULE = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt';
const BTC = 'bc1qjpmp8xvg9k4ysa7nvev3lw7qcclvxzt2ex75kr';
const ETH = '0x51176f5F0B7ccC8fA0376F08aaa28F316A38a2a0';
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
  assert.deepEqual(validateBondYieldReview({ ...named, thorname: { ...named.thorname, preferred_asset: 'BTC.BTC', aliases: [{ chain: 'BTC', address: BTC }] } }), { destination: BTC, asset: 'BTC.BTC', collector: true, thorname: 'yieldname' });
  assert.throws(() => validateBondYieldReview({ ...named, thorname: null }), /not found/);
  assert.throws(() => validateBondYieldReview({ ...named, thorname: { ...named.thorname, owner: TARGET } }), /must be owned/);
  assert.throws(() => validateBondYieldReview({ ...named, thorname: { ...named.thorname, aliases: [{ chain: 'THOR', address: MODULE }] } }), /network module/);
});

test('a preferred-asset payout cannot be approved without its receiving-chain alias', () => {
  assert.throws(() => validateBondYieldReview({ ...review, target: 'yieldname', thorname: {
    name: 'yieldname', owner: OWNER, preferred_asset: 'BTC.BTC', aliases: [{ chain: 'THOR', address: TARGET }]
  } }), /BTC.*alias|alias.*BTC/);
});

function clientFixture(overrides = {}) {
  const calls = [];
  const values = {
    '/thorchain/version': enabled.version, '/thorchain/mimir': enabled.mimir, '/thorchain/constants': constants,
    [`/thorchain/node/${NODE}`]: node,
    '/thorchain/thorname/yieldname': { name: 'yieldname', owner: OWNER, expire_block_height: 200, aliases: [] },
    '/thorchain/lastblock': [{ thorchain: 100 }],
    '/thorchain/pool/BTC.BTC': { asset: 'BTC.BTC', status: 'Available' },
    '/thorchain/pool/ETH.ETH': { asset: 'ETH.ETH', status: 'Available' },
    '/thorchain/inbound_addresses': [{ chain: 'BTC', halted: false }, { chain: 'ETH', halted: false }],
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
  assert.equal(client.calls.length, 6);
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
  const plan = planBondYield({ nodeAddress: NODE, percent: 50, payoutTarget: 'yieldname' });
  for (const outcome of [new Error('Bond yield is not enabled'), { destination: OWNER, asset: 'RUNE' }, { destination: TARGET, asset: 'RUNE' }]) {
    let executions = 0, checks = 0;
    const client = clientFixture(outcome instanceof Error ? { '/thorchain/mimir': outcome } : {
      '/thorchain/thorname/yieldname': { name: 'yieldname', owner: OWNER, expire_block_height: 99999999, aliases: [{ chain: 'THOR', address: outcome.destination }] }
    });
    const state = runInNewContext(`${sign}\n({ sign, state: () => ({ phase, results }) })`, {
      canSign: true, reviews: [{ plan, signer: { address: OWNER } }], phase: 'form', signError: '', results: [],
      plans: [plan], payoutMode: 'thorname', payoutAsset: 'THOR.RUNE', payoutAddress: TARGET, sentNameUpdate: '',
      spec: { owner: OWNER }, thornode: client, yieldDestination: { destination: TARGET, asset: 'RUNE' },
      fakeActions: { executePlan: async () => { executions++; return 'test-hash'; } }, dispatch: () => {},
      recheckBondYieldBeforeSigning: async (...args) => { checks++; return recheckBondYieldBeforeSigning(...args); }
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
    payoutMode: 'provider', payoutAsset: '', payoutAddress: '', acceptNameUpdate: false,
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
  const source = (await readFile(url, 'utf8')).replace("import { midgard, thornode } from '../api/index.js';", 'const thornode = {}; const midgard = {};');
  const { js } = compile(source, { generate: 'server', filename: url.pathname });
  const code = js.code.replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => `from ${quote}${specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)}${quote}`);
  const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const html = render(Component, { props: {
    spec: { kind: 'bond-yield', nodeAddress: NODE, owner: OWNER, bondYield: { bps: 4000, target: TARGET } },
    accounts: [{ provider: 'TEST', network: 'THOR', address: OWNER }], gates: review.gates
  } }).body;
  assert.match(html, new RegExp(`BONDYIELD:${NODE}:4000:${OWNER}`));
  assert.match(html, /0 THOR.RUNE/);
  assert.match(html, /40% paid out · 60% rebonded/);
  assert.match(html, /Check payout settings before signing/);
  assert.match(html, /class="bracket-btn primary" disabled/);
});

test('the page-load gate reads shared snapshots while signing still bypasses them', async () => {
  const display = clientFixture();
  assert.equal((await loadBondYieldGate(display, { fresh: false })).bondYieldEnabled, true);
  assert.ok(display.calls.every(({ options }) => options.coreSnapshot !== false && options.cache !== false));
  const signing = clientFixture();
  await loadBondYieldGate(signing);
  assert.ok(signing.calls.every(({ options }) => options.coreSnapshot === false && options.cache === false));
});

const assetReview = {
  plan: planBondYield({ nodeAddress: NODE, percent: 40, payoutTarget: 'yieldname' }),
  owner: OWNER, signer: OWNER, preferredAsset: 'BTC.BTC', payoutAddress: BTC
};
const nameRecord = { name: 'yieldname', owner: OWNER, expire_block_height: 200, preferred_asset: 'BTC.BTC', aliases: [{ chain: 'BTC', address: BTC }] };

test('asset choices include available supported pool assets without synthetic or secured balances', () => {
  const pools = ['BTC.BTC', 'THOR.TCY', 'ETH.ETH', 'ETH.ETH', 'BTC/BTC', 'BTC~BTC', 'BTC-BTC', 'THOR.RUNE', 'BOGUS.ASSET'].map((asset) => ({ asset, status: 'Available' }));
  pools.push({ asset: 'LTC.LTC', status: 'Staged' });
  assert.deepEqual(bondYieldAssetOptions(pools), ['BTC.BTC', 'ETH.ETH', 'THOR.TCY']);
});

test('preferred-asset setup preserves THORName ownership and has a separate zero-value review plan', async () => {
  const client = clientFixture();
  const result = await loadBondYieldReview(client, assetReview);
  assert.deepEqual(result, {
    destination: BTC, asset: 'BTC.BTC', collector: true, thorname: 'yieldname',
    currentAsset: 'RUNE', currentDestination: '', currentPayoutDestination: OWNER,
    setupPlan: { action: 'bond-yield-asset', title: 'Set yieldname payouts to BTC.BTC', chain: 'THOR', asset: 'THOR.RUNE', amount: '0', route: 'thor-deposit', memo: `~:yieldname:BTC:${BTC}::BTC.BTC` }
  });
  assert.ok(client.calls.every(({ options }) => options.cache === false && options.coreSnapshot === false));
});

test('an already configured preferred asset skips setup and resolves the actual receiving address', async () => {
  const client = clientFixture({ '/thorchain/thorname/yieldname': nameRecord });
  const result = await loadBondYieldReview(client, assetReview);
  assert.deepEqual(result, { destination: BTC, asset: 'BTC.BTC', collector: true, thorname: 'yieldname' });
  const generic = await loadBondYieldReview(client, { ...assetReview, preferredAsset: '', payoutAddress: '' });
  assert.deepEqual(generic, result);
});

test('changed asset and changed chain aliases are reflected in a new review', async () => {
  const before = await loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': nameRecord }), assetReview);
  const changed = { ...nameRecord, aliases: [{ chain: 'BTC', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }] };
  const after = await loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': changed }), assetReview);
  assert.notDeepEqual(after, before);
  assert.equal(after.currentDestination, changed.aliases[0].address);
  assert.equal(after.setupPlan.memo, `~:yieldname:BTC:${BTC}::BTC.BTC`);
  const switchAsset = await loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': nameRecord }), { ...assetReview, preferredAsset: 'ETH.ETH', payoutAddress: ETH });
  assert.equal(switchAsset.currentAsset, 'BTC.BTC');
  assert.equal(switchAsset.currentDestination, '');
  assert.equal(switchAsset.currentPayoutDestination, BTC);
  assert.equal(switchAsset.setupPlan.memo, `~:yieldname:ETH:${ETH}::ETH.ETH`);
});

test('preferred-asset checks reject unowned or expired names, mismatched pools, inactive routes and missing aliases', async () => {
  for (const [overrides, pattern] of [
    [{ '/thorchain/thorname/yieldname': { ...nameRecord, owner: TARGET } }, /owned/],
    [{ '/thorchain/thorname/yieldname': { ...nameRecord, expire_block_height: 99 } }, /expired/],
    [{ '/thorchain/lastblock': [] }, /expiry/],
    [{ '/thorchain/pool/BTC.BTC': { asset: 'ETH.ETH', status: 'Available' } }, /available/],
    [{ '/thorchain/pool/BTC.BTC': { asset: 'BTC.BTC', status: 'Staged' } }, /available/],
    [{ '/thorchain/inbound_addresses': [{ chain: 'BTC', chain_trading_paused: true }] }, /halted/],
    [{ '/thorchain/inbound_addresses': [] }, /verify/],
    [{ '/thorchain/mimir': { BONDYIELDENABLED: 1, HALTSIGNINGBTC: 99 } }, /halted/],
    [{ '/thorchain/mimir': { BONDYIELDENABLED: 1, THORNAMES: 0 } }, /updates.*disabled/]
  ]) await assert.rejects(loadBondYieldReview(clientFixture(overrides), assetReview), pattern);
  await assert.rejects(loadBondYieldReview(clientFixture(), { ...assetReview, signer: TARGET }), /provider wallet/);
  await assert.rejects(loadBondYieldReview(clientFixture(), { ...assetReview, plan: planBondYield({ nodeAddress: NODE, percent: 40, payoutTarget: OWNER }) }), /provider-owned THORName/);
  await assert.rejects(loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': { ...nameRecord, aliases: [] } }), { ...assetReview, preferredAsset: '' }), /receiving address/);
  const futureHalt = await loadBondYieldReview(clientFixture({ '/thorchain/mimir': { BONDYIELDENABLED: 1, HALTSIGNINGBTC: 101 } }), assetReview);
  assert.ok(futureHalt.setupPlan);
});

test('turning payouts off needs no asset, name, expiry, pool or external-route lookup', async () => {
  const client = clientFixture({ '/thorchain/thorname/yieldname': new Error('must not query') });
  assert.deepEqual(await loadBondYieldReview(client, { ...assetReview, plan: planBondYield({ nodeAddress: NODE, percent: 0 }), preferredAsset: 'bad:asset', payoutAddress: 'invalid' }), { destination: '', asset: 'RUNE' });
  assert.equal(client.calls.length, 4);
});

test('RUNE preferred-asset sentinel follows native payout behavior', () => {
  assert.deepEqual(validateBondYieldReview({ ...review, target: 'yieldname', thorname: { ...nameRecord, preferred_asset: 'THOR.RUNE', aliases: [] } }), { destination: OWNER, asset: 'RUNE' });
});

test('receiving addresses validate chain, mainnet, checksums and memo delimiters', async () => {
  const fixtures = [
    ['BTC.BTC', BTC], ['ETH.ETH', ETH], ['THOR.TCY', OWNER],
    ['BCH.BCH', 'qzhcfqxrnhcw88c433tq0fjlw0uut8c0e5d3cf8566'],
    ['DOGE.DOGE', 'DPrKsuhVibyfMMYRmKP49US5PBQR8zq6v4'],
    ['LTC.LTC', 'ltc1qs4h7p8x0kfhs88wazmq2d40t59dwdlxd6rlpjz'],
    ['ZEC.ZEC', 't1Mh7QW9g1gK94CSRxniD49aLAJ67s6UerX'],
    ['GAIA.ATOM', 'cosmos12d7d2rlxp7urkp8z0p8sft2fm07ewyjrfvul3f'],
    ['XRP.XRP', 'rhDQXdwWR2RstC7sLjLMbjCeWT3PuSAZVu'],
    ['TRON.TRX', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
    ['SOL.SOL', '4UHWuPwyV3XCcnwrpEdWAEW3WLUP1RDMaK3ANNsRUjfM']
  ];
  for (const [asset, address] of fixtures) {
    assert.equal(await bondYieldAssetAddress(asset, address), address);
    await assert.rejects(bondYieldAssetAddress(asset, `${address}:BTC.BTC`), /receiving address/);
    if (!asset.startsWith('SOL.')) await assert.rejects(bondYieldAssetAddress(asset, `${address.slice(0, -1)}!`), /receiving address/);
  }
  assert.equal(await bondYieldAssetAddress('BCH.BCH', 'bitcoincash:qzhcfqxrnhcw88c433tq0fjlw0uut8c0e5d3cf8566'), fixtures[3][1]);
  assert.equal(await bondYieldAssetAddress('BCH.BCH', 'BITCOINCASH:QZHCFQXRNHCW88C433TQ0FJLW0UUT8C0E5D3CF8566'), fixtures[3][1]);
  assert.equal(await bondYieldAssetAddress('LTC.LTC', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy');
  for (const address of ['tb1qfm9q8vhlw7nk42h7jlt3ghcvsn3rwcqxfk3u5f', ETH, `${BTC.slice(0, -1)}q`]) await assert.rejects(bondYieldAssetAddress('BTC.BTC', address));
  await assert.rejects(bondYieldAssetAddress('BCH.BCH', BTC));
  await assert.rejects(bondYieldAssetAddress('ETH.ETH', '0x0000000000000000000000000000000000000000'));
});

test('pre-signing checks stop wallet handoff after name ownership, receiving address or setup state changes', async () => {
  const ready = await loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': nameRecord }), assetReview);
  const setup = await loadBondYieldReview(clientFixture(), assetReview);
  for (const [client, checked, shouldSign] of [
    [clientFixture({ '/thorchain/thorname/yieldname': nameRecord }), ready, true],
    [clientFixture(), setup, true],
    [clientFixture({ '/thorchain/thorname/yieldname': nameRecord }), setup, false],
    [clientFixture({ '/thorchain/thorname/yieldname': { ...nameRecord, owner: TARGET } }), ready, false],
    [clientFixture({ '/thorchain/thorname/yieldname': { ...nameRecord, aliases: [{ chain: 'BTC', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }] } }), ready, false],
    [clientFixture({ '/thorchain/mimir': { BONDYIELDENABLED: 0 } }), ready, false]
  ]) {
    let walletCalled = false;
    const handoff = async () => {
      await recheckBondYieldBeforeSigning(client, assetReview, checked);
      walletCalled = true;
    };
    if (shouldSign) await handoff();
    else await assert.rejects(handoff());
    assert.equal(walletCalled, shouldSign);
  }
});

test('name discovery uses one owner query and verifies distinct active names against THORNode', async () => {
  const calls = [];
  const midgard = { fetch: async (route) => { calls.push(route); return ['YieldName', 'yieldname', 'expired', 'transferred', 'alpha']; } };
  const records = {
    yieldname: { ...nameRecord, name: 'yieldname' },
    alpha: { ...nameRecord, name: 'alpha' },
    expired: { ...nameRecord, name: 'expired', expire_block_height: 99 },
    transferred: { ...nameRecord, name: 'transferred', owner: TARGET }
  };
  const reads = [];
  const thornode = { fetch: async (route, options) => {
    reads.push({ route, options });
    return route === '/thorchain/lastblock' ? [{ thorchain: 100 }] : records[route.split('/').pop()];
  } };
  const result = await loadOwnedBondYieldNames(midgard, thornode, OWNER);
  assert.deepEqual(calls, [`/thorname/owner/${OWNER}`]);
  assert.deepEqual(result.names.map((record) => record.name), ['alpha', 'yieldname']);
  assert.equal(result.unavailableCount, 0);
  assert.equal(reads.length, 5);
  assert.ok(reads.every(({ options }) => options.cache === false && options.coreSnapshot === false));
});

test('name discovery distinguishes no names, provider outages and partial verification', async () => {
  const noNames = { fetch: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } };
  const noReads = { fetch: async () => { assert.fail('Empty owner lookup needs no THORNode reads'); } };
  assert.deepEqual(await loadOwnedBondYieldNames(noNames, noReads, OWNER), { names: [], unavailableCount: 0 });
  const offline = { fetch: async () => { throw Object.assign(new Error('offline'), { status: 503 }); } };
  await assert.rejects(loadOwnedBondYieldNames(offline, noReads, OWNER), /offline/);
  await assert.rejects(loadOwnedBondYieldNames({ fetch: async () => ({ names: [] }) }, noReads, OWNER), /owner list/);
  const client = clientFixture({ '/thorchain/thorname/unavailable': new Error('timeout') });
  const result = await loadOwnedBondYieldNames({ fetch: async () => ['yieldname', 'unavailable'] }, client, OWNER);
  assert.equal(result.names.length, 1);
  assert.equal(result.unavailableCount, 1);
});

test('only a connected THOR bond provider can supply the payout name choices', () => {
  assert.equal(connectedBondYieldOwner([{ network: 'THOR', address: OWNER.toUpperCase() }], OWNER), OWNER);
  assert.equal(connectedBondYieldOwner([{ network: 'ETH', address: OWNER }], OWNER), '');
  assert.equal(connectedBondYieldOwner([{ network: 'THOR', address: TARGET }], OWNER), '');
  assert.equal(connectedBondYieldOwner([], OWNER), '');
});

test('selecting an owned name fills the saved asset and matching receiving alias only', () => {
  assert.deepEqual(bondYieldNameFields(nameRecord, ['BTC.BTC']), { payoutTarget: 'yieldname', payoutAsset: 'BTC.BTC', payoutAddress: BTC });
  assert.deepEqual(bondYieldNameFields(nameRecord, ['ETH.ETH']), { payoutTarget: 'yieldname', payoutAsset: '', payoutAddress: '' });
  assert.equal(bondYieldNameFields({ ...nameRecord, aliases: [] }, ['BTC.BTC']).payoutAddress, '');
  assert.deepEqual(bondYieldNameFields({ ...nameRecord, preferred_asset: '.', aliases: [{ chain: 'THOR', address: TARGET }] }, ['BTC.BTC']), { payoutTarget: 'yieldname', payoutAsset: 'THOR.RUNE', payoutAddress: TARGET });
  assert.equal(bondYieldNameFields({ ...nameRecord, preferred_asset: '', aliases: [] }, []).payoutAddress, OWNER);
});

test('manually loaded names verify authority and expiry before exposing saved payout settings', async () => {
  const client = clientFixture({ '/thorchain/thorname/yieldname': nameRecord });
  assert.deepEqual(await loadBondYieldName(client, OWNER, ' YieldName '), nameRecord);
  assert.ok(client.calls.every(({ options }) => options.cache === false && options.coreSnapshot === false));
  await assert.rejects(loadBondYieldName(client, OWNER, TARGET), /provider-owned THORName/);
  for (const [overrides, message] of [
    [{ '/thorchain/thorname/yieldname': { ...nameRecord, owner: TARGET } }, /owned/],
    [{ '/thorchain/thorname/yieldname': { ...nameRecord, expire_block_height: 99 } }, /expired/],
    [{ '/thorchain/lastblock': [] }, /expiry/]
  ]) await assert.rejects(loadBondYieldName(clientFixture(overrides), OWNER, 'yieldname'), message);
});

test('a selected name can switch from an external asset to native RUNE with a separate name update', async () => {
  const client = clientFixture({ '/thorchain/thorname/yieldname': nameRecord });
  const result = await loadBondYieldReview(client, { ...assetReview, preferredAsset: 'THOR.RUNE', payoutAddress: TARGET });
  assert.equal(result.asset, 'RUNE');
  assert.equal(result.destination, TARGET);
  assert.equal(result.currentAsset, 'BTC.BTC');
  assert.equal(result.currentPayoutDestination, BTC);
  assert.equal(result.setupPlan.memo, `~:yieldname:THOR:${TARGET}::THOR.RUNE`);
  assert.ok(client.calls.every(({ url }) => !url.includes('/pool/') && !url.includes('/inbound_addresses')));
});

test('native THORName choices preserve a saved THOR alias or owner fallback, and permit an explicit alias update', async () => {
  const native = { ...nameRecord, preferred_asset: '.', aliases: [{ chain: 'THOR', address: TARGET }] };
  const input = { ...assetReview, preferredAsset: 'THOR.RUNE', payoutAddress: TARGET };
  const ready = await loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': native }), input);
  assert.deepEqual(ready, { destination: TARGET, asset: 'RUNE' });
  const changed = await loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': native }), { ...input, payoutAddress: OWNER });
  assert.equal(changed.setupPlan.memo, `~:yieldname:THOR:${OWNER}::THOR.RUNE`);
  const fallback = await loadBondYieldReview(clientFixture({ '/thorchain/thorname/yieldname': { ...native, aliases: [] } }), { ...input, payoutAddress: OWNER });
  assert.deepEqual(fallback, { destination: OWNER, asset: 'RUNE' });
  for (const payoutAddress of [MODULE, BTC, 'invalid']) await assert.rejects(loadBondYieldReview(clientFixture(), { ...input, payoutAddress }));
  await assert.rejects(loadBondYieldReview(clientFixture({ '/thorchain/mimir': { BONDYIELDENABLED: 1, THORNAMES: 0 } }), input), /updates.*disabled/);
});

test('name lookup ignores old wallet responses, disconnects immediately and deduplicates repeated requests', async () => {
  const deferred = new Map();
  const calls = [];
  const midgard = { fetch: (route, options) => {
    calls.push({ route, options });
    return new Promise((resolve) => deferred.set(route, resolve));
  } };
  const states = [];
  const lookup = createBondYieldNameLookup(midgard, clientFixture(), (state) => states.push(state));
  const first = lookup.setOwner(OWNER);
  await lookup.setOwner(OWNER);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cache, true);
  const second = lookup.setOwner(TARGET);
  deferred.get(`/thorname/owner/${TARGET}`)([]);
  await second;
  deferred.get(`/thorname/owner/${OWNER}`)(['yieldname']);
  await first;
  assert.equal(states.at(-1).owner, TARGET);
  assert.deepEqual(states.at(-1).names, []);
  const pending = lookup.setOwner(OWNER);
  await lookup.setOwner('');
  deferred.get(`/thorname/owner/${OWNER}`)(['yieldname']);
  await pending;
  assert.equal(states.at(-1).owner, '');
  assert.deepEqual(states.at(-1).names, []);
  const refresh = lookup.setOwner(OWNER, { refresh: true });
  assert.equal(calls.at(-1).options.cache, false);
  const beforeDispose = states.length;
  lookup.dispose();
  deferred.get(`/thorname/owner/${OWNER}`)(['yieldname']);
  await refresh;
  assert.equal(states.length, beforeDispose);
});
