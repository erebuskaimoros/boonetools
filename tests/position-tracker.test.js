import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import {
  addAddresses,
  detectAddressChain,
  loadTrackedAddresses,
  removeAddress,
  STORAGE_KEY,
  LEGACY_BOND_KEY
} from '../src/lib/position-tracker/addresses.js';
import {
  planAddLiquidityAsset,
  planAddLiquidityRune,
  planBond,
  planClaimTcy,
  planStakeTcy,
  planUnbond,
  planUnstakeTcy,
  planWithdrawLiquidity,
  toBaseUnits
} from '../src/lib/position-tracker/memos.js';
import {
  buildBondRows,
  buildLpRows,
  buildTcyClaimRows,
  buildTcyRows,
  mergePayoutSeries,
  rowsFor,
  summarize,
  summarizeByAddress
} from '../src/lib/position-tracker/model.js';
import { pickSigner } from '../src/lib/position-tracker/actions-signer.js';
import { createWalletConnectSession } from '../src/lib/limit-orders/wallet-connect-session.js';
import { readSavedWalletConnectChains, WALLET_STORAGE_KEY } from '../src/lib/limit-orders/wallet-config.js';

const THOR_A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const THOR_B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const NODE = 'thor100m5hh9qayap0edmvl9h8er4z6uesnfazjmefg';
const BTC = 'bc1qz375gdj6hdd7wr54nfnr2lvssfesna23njrx7a';

async function walletFunction(name, bindings, modulePath = '../src/lib/limit-orders/wallet.js') {
  const source = await readFile(new URL(modulePath, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('wallet.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must exist`);
  const executable = declaration.getText(parsed).replace(/^export\s+/, '');
  return runInNewContext(`${executable}\n${name}`, { console, ...bindings });
}

function walletSessionHarness(sdk, { restoreChains = [], enabled = true } = {}) {
  const saved = [];
  let finished = 0;
  const session = createWalletConnectSession({
    getSDK: () => sdk,
    supportedChains: ['THOR', 'ETH'],
    metadata: { name: 'BooneTools' },
    isEnabled: () => enabled,
    replaceAccounts: (accounts) => saved.push(accounts),
    readRestoreChains: () => restoreChains,
    finishRestore: () => finished++
  });
  return { session, saved, get finished() { return finished; } };
}

test('WalletConnect pairs once and only exposes accounts approved by that provider', async () => {
  const calls = [];
  let approved = false;
  const sdk = {
    async connectWalletconnect(chains, options) { calls.push({ chains: [...chains], options }); approved = true; return true; },
    getAddress(chain) { return chain === 'THOR' ? THOR_A : '0xUnrelatedExtensionAccount'; },
    getWallet(provider, chain) { return approved && provider === 'WALLETCONNECT' && chain === 'THOR' ? { address: THOR_A } : undefined; }
  };
  const { session, saved } = walletSessionHarness(sdk);
  const connect = await walletFunction('connectWallet', {
    WalletOption: { WALLETCONNECT: 'WALLETCONNECT' },
    getUSwap: () => sdk,
    walletConnectSession: session
  });
  const accounts = await connect('WALLETCONNECT', ['THOR', 'ETH']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].chains, ['THOR', 'ETH']);
  assert.deepEqual(JSON.parse(JSON.stringify(accounts)), [{ address: THOR_A, network: 'THOR', provider: 'WALLETCONNECT' }]);
  assert.equal(saved.length, 1);
});

test('disconnecting WalletConnect ends that provider without disconnecting another wallet on the same chain', async () => {
  const disconnected = [];
  const removed = [];
  const sdk = { getWallet: () => undefined, disconnectWallet: (provider) => disconnected.push(provider), disconnectChain: () => assert.fail('must not disconnect a shared chain') };
  const session = createWalletConnectSession({
    getSDK: () => sdk, supportedChains: ['THOR', 'ETH'], metadata: {}, isEnabled: () => true,
    replaceAccounts: () => removed.push('WALLETCONNECT'), readRestoreChains: () => [], finishRestore: () => {}
  });
  const disconnect = await walletFunction('disconnectWallet', {
    WalletOption: { WALLETCONNECT: 'WALLETCONNECT' },
    walletConnectSession: session
  });
  await disconnect('WALLETCONNECT');
  assert.deepEqual(disconnected, ['WALLETCONNECT']);
  assert.deepEqual(removed, ['WALLETCONNECT']);
});

test('WalletConnect reconnect preserves other approved chains and avoids a second pairing', async () => {
  let pairs = 0;
  const wallets = new Map();
  const sdk = {
    getWallet: (_provider, chain) => wallets.get(chain),
    async connectWalletconnect(chains) {
      pairs++;
      for (const chain of chains) wallets.set(chain, { address: chain === 'THOR' ? THOR_A : '0xWalletConnect' });
      return true;
    }
  };
  const { session, saved } = walletSessionHarness(sdk);
  await session.connect(['THOR', 'ETH']);
  const signingAccounts = await session.connect(['THOR'], { restoreOnly: true });
  assert.equal(pairs, 1);
  assert.deepEqual(signingAccounts.map((account) => account.network), ['THOR']);
  assert.deepEqual(saved.at(-1).map((account) => account.network), ['THOR', 'ETH']);
});

test('WalletConnect reload restores only an approved session without showing QR pairing', async () => {
  const optionsSeen = [];
  let approved = false;
  const sdk = {
    getWallet: (_provider, chain) => approved && chain === 'THOR' ? { address: THOR_A } : undefined,
    async connectWalletconnect(_chains, options) { optionsSeen.push(options); approved = true; return true; }
  };
  const harness = walletSessionHarness(sdk, { restoreChains: ['THOR', 'ETH'] });
  const [first, second] = await Promise.all([harness.session.restore(), harness.session.restore()]);
  assert.equal(optionsSeen.length, 1);
  assert.equal(optionsSeen[0].restoreOnly, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((account) => account.network), ['THOR']);
  assert.equal(harness.finished, 1);
});

test('WalletConnect expired saved session never populates accounts', async () => {
  const sdk = {
    getWallet: () => undefined,
    async connectWalletconnect(_chains, options) {
      assert.equal(options.restoreOnly, true);
      throw new Error('wallet_walletconnect_connection_not_established');
    }
  };
  const harness = walletSessionHarness(sdk, { restoreChains: ['THOR'] });
  await assert.rejects(harness.session.restore(), /connection_not_established/);
  assert.deepEqual(harness.saved.at(-1), []);
  assert.equal(harness.finished, 1);
});

test('WalletConnect phone disconnect removes only the affected chains', async () => {
  const wallets = new Map([['THOR', { address: THOR_A }], ['ETH', { address: '0xWalletConnect' }]]);
  const events = [];
  const sdk = {
    getWallet: (_provider, chain) => wallets.get(chain),
    disconnectWallet(provider, chains) {
      events.push([provider, chains]);
      for (const chain of chains) wallets.delete(chain);
    }
  };
  const harness = walletSessionHarness(sdk);
  harness.session.disconnected(['ETH']);
  assert.deepEqual(events, [['WALLETCONNECT', ['ETH']]]);
  assert.deepEqual(harness.saved.at(-1), [{ address: THOR_A, network: 'THOR', provider: 'WALLETCONNECT' }]);
});

test('WalletConnect disconnect during pairing discards late approval', async () => {
  let finishPair;
  let pairingStarted;
  const started = new Promise((resolve) => { pairingStarted = resolve; });
  let approved = false;
  const sdk = {
    getWallet: () => approved ? { address: THOR_A } : undefined,
    async connectWalletconnect() {
      pairingStarted();
      await new Promise((resolve) => { finishPair = resolve; });
      approved = true;
      return true;
    },
    disconnectWallet: () => { approved = false; }
  };
  const harness = walletSessionHarness(sdk);
  const connection = harness.session.connect(['THOR']);
  await started;
  harness.session.disconnect();
  finishPair();
  assert.deepEqual(await connection, []);
  assert.deepEqual(harness.saved.at(-1), []);
  assert.equal(approved, false);
});

test('WalletConnect cancellation preserves existing approved chains', async () => {
  const sdk = {
    getWallet: (_provider, chain) => chain === 'THOR' ? { address: THOR_A } : undefined,
    async connectWalletconnect() { throw new Error('wallet_walletconnect_user_rejected'); }
  };
  const harness = walletSessionHarness(sdk);
  await assert.rejects(harness.session.connect(['ETH']), /user_rejected/);
  assert.deepEqual(harness.saved.at(-1), [{ address: THOR_A, network: 'THOR', provider: 'WALLETCONNECT' }]);
});

test('WalletConnect missing project configuration fails before invoking the SDK', async () => {
  let pairs = 0;
  const harness = walletSessionHarness({ connectWalletconnect: () => pairs++ }, { enabled: false });
  await assert.rejects(harness.session.connect(['THOR']), /not configured/);
  assert.equal(pairs, 0);
});

test('WalletConnect saved storage exposes only chain hints and rejects malformed records', () => {
  assert.deepEqual(readSavedWalletConnectChains(memoryStorage({ [WALLET_STORAGE_KEY]: JSON.stringify({
    accounts: [{ provider: 'WALLETCONNECT', network: 'THOR', address: THOR_A }, { provider: 'KEPLR', network: 'GAIA' }],
    walletConnectChains: ['THOR', 'eth', null, 'https://example.org']
  }) })), ['THOR', 'ETH']);
  assert.deepEqual(readSavedWalletConnectChains(memoryStorage({ [WALLET_STORAGE_KEY]: 'broken' })), []);
});

test('WalletConnect saved addresses stay unavailable as signers until restoration succeeds', async () => {
  const original = globalThis.localStorage;
  const storage = memoryStorage({ [WALLET_STORAGE_KEY]: JSON.stringify({
    accounts: [
      { provider: 'WALLETCONNECT', network: 'THOR', address: THOR_A },
      { provider: 'KEPLR', network: 'THOR', address: THOR_B }
    ],
    connectedWallets: ['WALLETCONNECT', 'KEPLR'],
    selectedAccount: { provider: 'WALLETCONNECT', network: 'THOR', address: THOR_A }
  }) });
  globalThis.localStorage = storage;
  try {
    const store = await import(`../src/lib/limit-orders/store.js?walletconnect-restore-test=${Date.now()}`);
    let accounts;
    let providers;
    store.walletAccounts.subscribe((value) => { accounts = value; })();
    store.connectedWallets.subscribe((value) => { providers = value; })();
    assert.deepEqual(accounts.map((account) => account.provider), ['KEPLR']);
    assert.deepEqual(providers, ['KEPLR']);
    assert.deepEqual(store.getWalletConnectRestoreChains(), ['THOR']);
    assert.deepEqual(readSavedWalletConnectChains(storage), ['THOR']);
    store.finishWalletConnectRestore();
    assert.deepEqual(readSavedWalletConnectChains(storage), []);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('WalletConnect signing reconnect restores only the reviewed account without QR pairing', async () => {
  const signer = { provider: 'WALLETCONNECT', network: 'THOR', address: THOR_A };
  const calls = [];
  const ensureConnected = await walletFunction('ensureConnected', {
    getUSwap: () => ({ getWallet: () => undefined }),
    connectWallet: async (provider, chains, config) => { calls.push({ provider, chains: [...chains], config }); return [signer]; }
  }, '../src/lib/position-tracker/actions.js');
  await ensureConnected(signer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'WALLETCONNECT');
  assert.deepEqual(calls[0].chains, ['THOR']);
  assert.equal(calls[0].config.restoreOnly, true);
});

test('WalletConnect account mismatch aborts before any signing or broadcasting', async () => {
  const signer = { provider: 'WALLETCONNECT', network: 'THOR', address: THOR_A };
  for (const alreadyConnected of [true, false]) {
    const ensureConnected = await walletFunction('ensureConnected', {
      getUSwap: () => ({ getWallet: () => alreadyConnected ? { address: THOR_B } : undefined }),
      connectWallet: async () => [{ ...signer, address: THOR_B }]
    }, '../src/lib/position-tracker/actions.js');
    const execute = await walletFunction('executePlan', {
      ensureConnected,
      getUSwap: () => assert.fail('must abort before transaction setup'),
      withActiveProvider: () => assert.fail('must abort before signing')
    }, '../src/lib/position-tracker/actions.js');
    await assert.rejects(execute({ route: 'thor-deposit', chain: 'THOR' }, signer), /account changed/);
  }
});

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('detects chains for common THORChain-supported address formats', () => {
  assert.equal(detectAddressChain(THOR_A), 'THOR');
  assert.equal(detectAddressChain(THOR_A.toUpperCase()), 'THOR');
  assert.equal(detectAddressChain(BTC), 'BTC');
  assert.equal(detectAddressChain('0x08fbdd8a38d2eb996f35e493b89e06c7218048c5'), 'EVM');
  assert.equal(detectAddressChain('cosmos1j722pvfah52yrw904cem4mn67ravzrhu5yvp5h'), 'GAIA');
  assert.equal(detectAddressChain('Fw4wRptZuhFdMvNqGyNQdoEP1zeJEN37MNU7dQmwc52t'), 'SOL');
  assert.equal(detectAddressChain('not-an-address'), '');
});

test('adds multiple addresses at once, de-duplicates, and rejects junk', () => {
  const { list, added, rejected } = addAddresses([], `${THOR_A}, ${THOR_A.toUpperCase()}\n${BTC} junk`);
  assert.deepEqual(list.map((entry) => entry.address), [THOR_A, BTC]);
  assert.equal(added.length, 2);
  assert.deepEqual(rejected, ['junk']);
  assert.deepEqual(removeAddress(list, THOR_A).map((entry) => entry.address), [BTC]);
});

test('seeds from the legacy Bond Tracker address and URL params', () => {
  const legacy = loadTrackedAddresses({ storage: memoryStorage({ [LEGACY_BOND_KEY]: THOR_A }) });
  assert.deepEqual(legacy.map((entry) => entry.address), [THOR_A]);

  const fromUrl = loadTrackedAddresses({
    storage: memoryStorage({ [STORAGE_KEY]: JSON.stringify([{ address: THOR_A, label: 'main' }]) }),
    search: `?bond_address=${THOR_B}`
  });
  assert.deepEqual(fromUrl.map((entry) => [entry.address, entry.label]), [[THOR_A, 'main'], [THOR_B, '']]);
});

test('bond and unbond plans use MsgDeposit memos with base-unit unbond amounts', () => {
  assert.deepEqual(planBond({ nodeAddress: NODE, amount: '1500.5' }), {
    action: 'bond',
    title: `Bond 1500.5 RUNE to node …mefg`,
    chain: 'THOR',
    asset: 'THOR.RUNE',
    amount: '1500.5',
    memo: `BOND:${NODE}`,
    route: 'thor-deposit'
  });
  const unbond = planUnbond({ nodeAddress: NODE, amount: '0.00000001' });
  assert.equal(unbond.memo, `UNBOND:${NODE}:1`);
  assert.equal(unbond.amount, '0');
  assert.equal(toBaseUnits('12.3'), '1230000000');
  assert.throws(() => planBond({ nodeAddress: BTC, amount: '1' }), /thor1/);
  assert.throws(() => planBond({ nodeAddress: NODE, amount: '1.123456789' }), /8 decimals/);
  assert.throws(() => planUnbond({ nodeAddress: NODE, amount: '0' }), /greater than zero/);
});

test('liquidity plans pair sides and route asset deposits through inbound vaults', () => {
  assert.equal(planAddLiquidityRune({ pool: 'btc.btc', amount: '10', pairedAddress: BTC }).memo, `+:BTC.BTC:${BTC}`);
  assert.equal(planAddLiquidityRune({ pool: 'BTC.BTC', amount: '10' }).memo, '+:BTC.BTC');

  const asset = planAddLiquidityAsset({ pool: 'BTC.BTC', amount: '0.1', pairedThorAddress: THOR_A });
  assert.equal(asset.memo, `+:BTC.BTC:${THOR_A}`);
  assert.equal(asset.chain, 'BTC');
  assert.equal(asset.route, 'inbound');

  assert.equal(planWithdrawLiquidity({ pool: 'BTC.BTC', percent: 25 }).memo, '-:BTC.BTC:2500');
  assert.equal(planWithdrawLiquidity({ pool: 'BTC.BTC', percent: 100, target: 'rune' }).memo, '-:BTC.BTC:10000:THOR.RUNE');
  const assetSide = planWithdrawLiquidity({ pool: 'BTC.BTC', percent: 50, side: 'asset' });
  assert.equal(assetSide.chain, 'BTC');
  assert.equal(assetSide.route, 'inbound-dust');
  assert.throws(() => planWithdrawLiquidity({ pool: 'BTC.BTC', percent: 101 }), /between 0 and 100/);
});

test('TCY plans match ThorNode memo grammar', () => {
  assert.equal(planStakeTcy({ amount: '100' }).memo, 'TCY+');
  assert.equal(planStakeTcy({ amount: '100' }).asset, 'THOR.TCY');
  assert.equal(planUnstakeTcy({ percent: 12.5 }).memo, 'TCY-:1250');
  const claim = planClaimTcy({ chain: 'eth', thorAddress: THOR_A });
  assert.equal(claim.memo, `TCY:${THOR_A}`);
  assert.equal(claim.chain, 'ETH');
  assert.equal(claim.route, 'inbound-dust');
});

test('bond rows split awards by share and credit the operator fee', () => {
  const nodes = [{
    node_address: NODE,
    node_operator_address: THOR_A,
    status: 'Active',
    current_award: String(100e8),
    bond_providers: {
      node_operator_fee: '2000',
      providers: [
        { bond_address: THOR_A, bond: String(250_000e8) },
        { bond_address: THOR_B, bond: String(750_000e8) },
        { bond_address: 'thor1other', bond: String(0.5e8) }
      ]
    }
  }];
  const rows = buildBondRows({ nodes, addresses: [THOR_A, THOR_B], runePriceUsd: 2 });
  const provider = rows.find((row) => row.address === THOR_B);
  const operator = rows.find((row) => row.address === THOR_A);
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(provider.share - 0.75) < 1e-5);
  assert.ok(Math.abs(provider.pendingReward - 60) < 1e-3);
  assert.ok(Math.abs(operator.pendingReward - 40) < 1e-3);
  assert.ok(operator.isOperator);
  assert.equal(provider.bondUsd, 1_500_000);
});

test('LP rows prefer live THORNode redeem values and classify position type', () => {
  const memberPools = [
    { pool: 'GAIA.ATOM', runeAddress: THOR_A, assetAddress: 'cosmos1x', liquidityUnits: '100', runeDeposit: '1', assetDeposit: '1' },
    { pool: 'BTC.BTC', runeAddress: '', assetAddress: BTC, liquidityUnits: '50', runeDeposit: '0', assetDeposit: String(1e8) },
    { pool: 'ETH.ETH', runeAddress: THOR_A, assetAddress: '', liquidityUnits: '0', runeDeposit: '5', assetDeposit: '0' }
  ];
  const providers = {
    [`GAIA.ATOM|${THOR_A}`]: { rune_redeem_value: String(100e8), asset_redeem_value: String(20e8), rune_deposit_value: String(90e8), asset_deposit_value: String(20e8), luvi_growth_pct: '0.1' }
  };
  const rows = buildLpRows({ memberPools, providers, addresses: [THOR_A, BTC], prices: { 'THOR.RUNE': 1, 'GAIA.ATOM': 5, 'BTC.BTC': 60000 } });
  assert.equal(rows.length, 2);
  const atom = rows.find((row) => row.pool === 'GAIA.ATOM');
  assert.equal(atom.type, 'sym');
  assert.equal(atom.valueUsd, 200);
  assert.equal(atom.gainUsd, 10);
  const btc = rows.find((row) => row.pool === 'BTC.BTC');
  assert.equal(btc.type, 'asset');
  assert.equal(btc.owner, BTC);
  assert.equal(btc.hasLiveValue, false);
});

test('TCY rows value stakes and payouts at payout-time prices', () => {
  const rows = buildTcyRows({
    addresses: [THOR_A, THOR_B],
    stakers: { [THOR_A]: { amount: String(1000e8) }, [THOR_B]: { amount: '0' } },
    balances: { [THOR_A]: String(10e8), [THOR_B]: '0' },
    distributions: {
      [THOR_A]: { apr: '0.085', distributions: [
        { date: '86400', amount: String(2e8), price: String(0.5e8) },
        { date: '172800', amount: String(3e8), price: String(1e8) }
      ] }
    },
    tcyPriceUsd: 0.2,
    runePriceUsd: 2,
    nowSec: 172800
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stakedUsd, 200);
  assert.equal(rows[0].totalPayoutRune, 5);
  assert.equal(rows[0].totalPayoutUsdAtPayout, 4);
  assert.equal(rows[0].totalPayoutUsdNow, 10);
  assert.equal(rows[0].lastPayout.date, 172800);
  assert.ok(Math.abs(rows[0].apr - (10 / 200 * 365 / 30 * 100)) < 1e-9);
  assert.deepEqual(mergePayoutSeries(rows).map((day) => day.rune), [2, 3]);

  const claims = buildTcyClaimRows([{ l1_address: BTC, asset: 'BTC.BTC', amount: String(50e8) }], 0.2);
  assert.equal(claims[0].chain, 'BTC');
  const totals = summarize({ tcyRows: rows, claimRows: claims });
  assert.equal(totals.claimableTcy, 50);
  assert.equal(totals.tcyUsd, 202);
});

test('per-address totals attribute each position to one owner', () => {
  const bondRows = [{ address: THOR_A, bond: 100, bondUsd: 300 }, { address: THOR_B, bond: 10, bondUsd: 30 }];
  // A symmetric position whose RUNE and BTC sides are both tracked belongs to the RUNE side.
  const lpRows = [
    { owner: THOR_A, runeAddress: THOR_A, assetAddress: BTC, valueUsd: 50, gainUsd: 0 },
    { owner: BTC, runeAddress: '', assetAddress: BTC, valueUsd: 20, gainUsd: 0 }
  ];
  const tcyRows = [{ address: THOR_B, staked: 1, stakedUsd: 5, liquidUsd: 1, totalPayoutRune: 0, totalPayoutUsdAtPayout: 0 }];

  assert.deepEqual(rowsFor(lpRows, BTC.toUpperCase()).map((row) => row.valueUsd), [20]);
  assert.equal(rowsFor(bondRows, '').length, 2);

  const split = summarizeByAddress({ addresses: [THOR_A, THOR_B, BTC], bondRows, lpRows, tcyRows });
  assert.deepEqual(split.map((row) => row.totalUsd), [350, 36, 20]);
  assert.equal(split.reduce((sum, row) => sum + row.totalUsd, 0), summarize({ bondRows, lpRows, tcyRows }).totalUsd);
});

test('signer selection prefers the address that owns the position', () => {
  const accounts = [
    { address: THOR_B, network: 'THOR', provider: 'KEPLR' },
    { address: THOR_A, network: 'THOR', provider: 'VULTISIG' },
    { address: '0xabc', network: 'ETH', provider: 'METAMASK' }
  ];
  assert.equal(pickSigner(accounts, { chain: 'THOR' }, THOR_A).provider, 'VULTISIG');
  assert.equal(pickSigner(accounts, { chain: 'THOR' }).provider, 'KEPLR');
  assert.equal(pickSigner(accounts, { chain: 'BTC' }), null);
});
