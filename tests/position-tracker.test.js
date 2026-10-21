import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

const THOR_A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const THOR_B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const NODE = 'thor100m5hh9qayap0edmvl9h8er4z6uesnfazjmefg';
const BTC = 'bc1qz375gdj6hdd7wr54nfnr2lvssfesna23njrx7a';

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
    stakers: { [THOR_A]: { amount: String(1000e8) } },
    balances: { [THOR_A]: String(10e8) },
    distributions: {
      [THOR_A]: { apr: '0.085', distributions: [
        { date: '86400', amount: String(2e8), price: String(0.5e8) },
        { date: '172800', amount: String(3e8), price: String(1e8) }
      ] }
    },
    tcyPriceUsd: 0.2,
    runePriceUsd: 2
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stakedUsd, 200);
  assert.equal(rows[0].totalPayoutRune, 5);
  assert.equal(rows[0].totalPayoutUsdAtPayout, 4);
  assert.equal(rows[0].totalPayoutUsdNow, 10);
  assert.equal(rows[0].lastPayout.date, 172800);
  assert.ok(Math.abs(rows[0].apr - 8.5) < 1e-9);
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

test('Thorfolio lives at /thorfolio and old /bond-tracker links still reach it', async () => {
  const appSource = await readFile(new URL('../src/App.svelte', import.meta.url), 'utf8');
  const visibleApps = appSource.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';
  assert.match(appSource, /const positionTrackerApp = \{\s*name: "Thorfolio",[^}]*path: "thorfolio"/);
  assert.equal(visibleApps.includes('positionTrackerApp'), true);
  assert.match(appSource, /routeAliases = \{ "bond-tracker": positionTrackerApp\.path \}/);
  assert.match(appSource, /path: "bond-tracker-classic"/);
  // Both entry points (first load and back/forward) rewrite a retired path in place.
  assert.equal(appSource.match(/canonicalizeAliasUrl\(path, app\);/g)?.length, 2);
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
