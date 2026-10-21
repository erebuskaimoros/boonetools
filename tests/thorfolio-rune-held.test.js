import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isThorAddress } from '../src/lib/position-tracker/addresses.js';
import { buildRuneRows, buildTcyRows, buildTcyClaimRows, rowsFor, summarize, summarizeByAddress } from '../src/lib/position-tracker/model.js';

const A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const BTC = 'bc1qz375gdj6hdd7wr54nfnr2lvssfesna23njrx7a';
const bank = (amount) => ({ balances: [{ denom: 'rune', amount }] });

test('held RUNE counts native wallet coins once, excludes other assets and keeps eight decimals', () => {
  const runeRows = buildRuneRows({
    addresses: [A, A.toUpperCase(), B, BTC], runePriceUsd: 2,
    walletBalances: {
      [A]: { balances: [{ denom: 'tcy', amount: '99900000000' }, { denom: 'btc/btc', amount: '99900000000' }, { denom: 'rune', amount: '123456789' }] },
      [B]: bank('1'), [BTC]: bank('99900000000')
    }
  });
  assert.equal(runeRows.length, 2);
  assert.equal(runeRows[0].rune, 1.23456789);
  assert.equal(runeRows[1].rune, 0.00000001);
  const totals = summarize({ runeRows });
  assert.ok(Math.abs(totals.runeHeld - 1.2345679) < 1e-10);
  assert.equal(totals.totalUsd, totals.runeUsd);
  assert.equal(totals.runeBalanceMissing, 0);
});

test('wallet holdings contribute to portfolio and address totals without counting pending rewards twice', () => {
  const runeRows = buildRuneRows({ addresses: [A, B], walletBalances: { [A]: bank('250000000'), [B]: bank('100000000') }, runePriceUsd: 2 });
  const positions = {
    runeRows,
    bondRows: [{ address: A, bond: 100, bondUsd: 200, pendingReward: 50, pendingRewardUsd: 100 }],
    lpRows: [{ owner: B, valueUsd: 20, gainUsd: 0 }],
    tcyRows: [{ address: A, staked: 10, stakedUsd: 10, liquidUsd: 1, totalPayoutRune: 25, totalPayoutUsdAtPayout: 50 }]
  };
  assert.equal(summarize(positions).totalUsd, 238);
  const split = summarizeByAddress({ addresses: [A, B, BTC], ...positions });
  assert.deepEqual(split.map((row) => row.totalUsd), [216, 22, 0]);
  assert.equal(summarize({ runeRows: rowsFor(runeRows, B) }).runeHeld, 1);
  assert.equal(summarizeByAddress({ addresses: [B], ...positions })[0].runeUsd, 2);
});

test('empty wallets are known zero while failed or invalid lookups stay unavailable', () => {
  for (const bad of [undefined, null, {}, bank('bad'), bank('-1')]) {
    const runeRows = buildRuneRows({ addresses: [A, B], walletBalances: { [A]: { balances: [] }, [B]: bad }, runePriceUsd: 2 });
    assert.equal(runeRows[0].rune, 0);
    assert.equal(runeRows[0].balanceKnown, true);
    assert.equal(runeRows[1].rune, null);
    assert.equal(runeRows[1].valueUsd, null);
    assert.equal(summarize({ runeRows }).runeBalanceMissing, 1);
    assert.equal(summarizeByAddress({ addresses: [B], runeRows })[0].runeBalanceMissing, 1);
  }
});

const dataSource = readFileSync(new URL('../src/lib/position-tracker/data.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
function createLoader(client) {
  return runInNewContext(`${dataSource}\n({ loadTcy })`, {
    isThorAddress, buildTcyRows, buildTcyClaimRows,
    thornode: { fetch: async () => ({ amount: '0' }), ...client },
    midgard: { getTCYDistribution: async () => ({ distributions: [] }) }
  });
}

test('held RUNE and liquid TCY share one fresh bank lookup per THOR address', async () => {
  const calls = [];
  const loader = createLoader({ getBalance: async (address, options) => {
    calls.push({ address, options });
    return { balances: [{ denom: 'rune', amount: '250000000' }, { denom: 'tcy', amount: '300000000' }] };
  } });
  const result = await loader.loadTcy([A, B, BTC], { runePriceUsd: 2, tcyPriceUsd: 1 });
  assert.deepEqual(calls.map((call) => call.address).sort(), [A, B].sort());
  assert.ok(calls.every((call) => call.options.cache === false));
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].liquid, 3);
  assert.equal(summarize({ runeRows: buildRuneRows({ addresses: [A, B], walletBalances: result.walletBalances, runePriceUsd: 2 }) }).runeHeld, 5);
  assert.equal(result.errors.length, 0);
});

test('bank pagination cannot hide RUNE behind other denominations', async () => {
  const calls = [];
  const loader = createLoader({
    getBalance: async () => ({ balances: [{ denom: 'btc/btc', amount: '100000000' }], pagination: { next_key: 'a+/=' } }),
    fetch: async (route, options) => {
      if (route.startsWith('/thorchain/')) return { amount: '0' };
      calls.push({ route, options });
      return bank('12300000000');
    }
  });
  const result = await loader.loadTcy([A], { runePriceUsd: 2, tcyPriceUsd: 1 });
  assert.equal(calls[0].route, `/cosmos/bank/v1beta1/balances/${A}?pagination.key=a%2B%2F%3D`);
  assert.equal(calls[0].options.cache, false);
  assert.equal(buildRuneRows({ addresses: [A], walletBalances: result.walletBalances })[0].rune, 123);
});

test('failed or malformed bank responses flag only the affected address, and a later refresh recovers', async () => {
  let unavailable = true;
  const loader = createLoader({ getBalance: async (address) => {
    if (unavailable && address === B) throw new Error('timeout');
    return bank('100000000');
  } });
  const market = { runePriceUsd: 2, tcyPriceUsd: 1 };
  const failed = await loader.loadTcy([A, B], market);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.walletBalances[B], null);
  assert.equal(buildRuneRows({ addresses: [A], walletBalances: failed.walletBalances })[0].rune, 1);
  unavailable = false;
  const recovered = await loader.loadTcy([A, B], market);
  assert.equal(recovered.errors.length, 0);
  assert.equal(buildRuneRows({ addresses: [B], walletBalances: recovered.walletBalances })[0].rune, 1);
  const malformed = await createLoader({ getBalance: async () => ({}) }).loadTcy([A], market);
  assert.equal(malformed.walletBalances[A], null);
  assert.equal(malformed.errors.length, 1);
});
