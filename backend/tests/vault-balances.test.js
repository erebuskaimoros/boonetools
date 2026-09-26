import test from 'node:test';
import assert from 'node:assert/strict';
import { collectVaultBalances } from '../src/vault-balances/index.js';
import { units } from '../src/vault-balances/common.js';

const selectors = { balanceOf: '0x70a08231', vaultAllowance: '0x03b6a673', decimals: '0x313ce567' };
const encoded = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const address = '0x1111111111111111111111111111111111111111';
const router = '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146';
const token = '0x3333333333333333333333333333333333333333';
const now = Date.parse('2026-09-26T12:00:00Z');
const response = payload => ({ ok: true, json: async () => payload });
const vault = (chain, asset, amount = '100000000', addr = 'vault') => ({ pub_key: 'vault-key', addresses: [{ chain, address: addr }], coins: [{ asset, amount }] });

test('a drained BTC vault is independently observed as zero and retains the THORNode comparison', async () => {
  const input = [vault('BTC', 'BTC.BTC')];
  const result = await collectVaultBalances(input, [], { now, fetchImpl: async () => response({ chain_stats: { funded_txo_sum: 100, spent_txo_sum: 100 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }) });
  const coin = result.vaults[0].coins[0];
  assert.equal(coin.amount, '0');
  assert.equal(coin.thornode_amount, '100000000');
  assert.equal(coin.balance_status, 'verified');
  assert.equal(input[0].coins[0].amount, '100000000');
});

test('malformed and failed explorer replies are unavailable, never zero or verified fallback', async () => {
  for (const fetchImpl of [async () => response({}), async () => { throw new Error('offline'); }]) {
    const result = await collectVaultBalances([vault('BTC', 'BTC.BTC')], [], { now, fetchImpl });
    const coin = result.vaults[0].coins[0];
    assert.equal(coin.balance_status, 'unavailable');
    assert.equal(coin.amount, '100000000');
    assert.equal(coin.balance_observed_at, undefined);
  }
});

test('one failed vault does not discard successful L1 results and unsupported assets remain explicit', async () => {
  const input = [vault('LTC', 'LTC.LTC', '100', 'good'), { ...vault('LTC', 'LTC.LTC', '100', 'bad'), pub_key: 'other' }, vault('UNKNOWN', 'UNKNOWN.TOKEN')];
  const result = await collectVaultBalances(input, [], { now, fetchImpl: async url => {
    if (url.includes('bad')) throw new Error('offline');
    return response({ chain_stats: { funded_txo_sum: 250, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 50 } });
  } });
  assert.equal(result.vaults[0].coins[0].amount, '200');
  assert.equal(result.vaults[1].coins[0].balance_status, 'unavailable');
  assert.equal(result.vaults[2].coins[0].balance_status, 'unsupported');
});

test('EVM checks native balance, per-vault allowance and physical router backing at one block', async () => {
  const input = { ...vault('AVAX', 'AVAX.AVAX', '200000000', address), routers: [{ chain: 'AVAX', router }], coins: [{ asset: 'AVAX.AVAX', amount: '200000000' }, { asset: `AVAX.USDC-${token.toUpperCase()}`, amount: '1000000000' }] };
  const seen = [];
  const result = await collectVaultBalances([input], [], { now, fetchImpl: async (_url, options) => {
    const requests = JSON.parse(options.body);
    const reply = request => {
      seen.push(request);
      let value;
      if (request.method === 'eth_blockNumber') value = '0x123';
      else if (request.method === 'eth_getBalance') value = '0x0';
      else if (request.params[0].data.startsWith(selectors.decimals)) value = encoded(6);
      else if (request.params[0].data.startsWith(selectors.vaultAllowance)) value = encoded(10_000_000n);
      else value = encoded(1_000_000n);
      return { jsonrpc: '2.0', id: request.id, result: value };
    };
    return response(Array.isArray(requests) ? requests.map(reply) : reply(requests));
  } });
  assert.equal(result.vaults[0].coins[0].amount, '0');
  assert.equal(result.vaults[0].coins[1].amount, '1000000000');
  assert.equal(result.vaults[0].coins[1].balance_scope, 'router_allowance');
  assert.equal(result.routerChecks[0].status, 'shortfall');
  assert.equal(result.routerChecks[0].actual_amount, '100000000');
  assert.equal(result.routerChecks[0].allowance_amount, '1000000000');
  assert.ok(seen.filter(x => x.method !== 'eth_blockNumber').every(x => x.params[1] === '0x123'));
});

test('RPC item errors and missing decimals cannot become verified EVM balances', async () => {
  const input = { ...vault('BASE', 'BASE.ETH', '200000000', address), routers: [{ chain: 'BASE', router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' }], coins: [{ asset: 'BASE.ETH', amount: '200000000' }, { asset: `BASE.USDC-${token}`, amount: '1000000000' }] };
  const result = await collectVaultBalances([input], [], { now, fetchImpl: async (_url, options) => {
    const reqs = JSON.parse(options.body);
    return response(reqs.map(r => ({ id: r.id, ...(r.method === 'eth_blockNumber' ? { result: '0x123' } : { error: { message: 'unavailable' } }) })));
  } });
  assert.ok(result.vaults[0].coins.every(c => c.balance_status === 'unavailable'));
});

test('XRP validated drops and SOL lamports convert exactly to THORChain units', async () => {
  const result = await collectVaultBalances([vault('XRP', 'XRP.XRP'), { ...vault('SOL', 'SOL.SOL'), pub_key: 'sol' }], [], { now, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    return response(request.method === 'account_info'
      ? { result: { validated: true, ledger_index: 1, account_data: { Balance: '1234567' } } }
      : { result: { context: { slot: 2 }, value: 1234567890 } });
  } });
  assert.equal(result.vaults[0].coins[0].amount, '123456700');
  assert.equal(result.vaults[1].coins[0].amount, '123456789');
});

test('unknown XRP account only counts as zero at a validated ledger', async () => {
  const result = await collectVaultBalances([vault('XRP', 'XRP.XRP')], [], { now, fetchImpl: async () => response({ result: { error: 'actNotFound', validated: true, ledger_index: 123 } }) });
  assert.equal(result.vaults[0].coins[0].amount, '0');
});

test('Cosmos only infers zero after complete pagination, and maps known IBC denoms', async () => {
  let calls = 0;
  const input = vault('GAIA', 'GAIA.ATOM');
  input.coins.push({ asset: 'GAIA.NAMI', amount: '500' });
  const result = await collectVaultBalances([input], [], { now, fetchImpl: async url => {
    calls++;
    return response(url.includes('pagination.key=next')
      ? { balances: [{ denom: 'uatom', amount: '123' }], pagination: { next_key: null } }
      : { balances: [{ denom: 'ibc/4622E82B845FFC6AA8B45C1EB2F507133A9E876A5FEA1BA64585D5F564405453', amount: '456' }], pagination: { next_key: 'next' } });
  } });
  assert.equal(calls, 2);
  assert.equal(result.vaults[0].coins[0].amount, '12300');
  assert.equal(result.vaults[0].coins[1].amount, '45600');
});

test('DOGE final balance includes pending changes; BCH uses integer satoshis', async () => {
  const result = await collectVaultBalances([vault('DOGE', 'DOGE.DOGE'), { ...vault('BCH', 'BCH.BCH'), pub_key: 'bch' }], [], { now, fetchImpl: async url => response(url.includes('blockcypher')
    ? { final_balance: 42 }
    : { confirmed: 20, unconfirmed: -5 }) });
  assert.equal(result.vaults[0].coins[0].amount, '42');
  assert.equal(result.vaults[1].coins[0].amount, '15');
});

test('V6 router tokens use the vault balance and do not create a fictitious router shortfall', async () => {
  const input = { ...vault('BASE', 'BASE.ETH', '100', address), routers: [{ chain: 'BASE', router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' }], coins: [{ asset: `BASE.USDC-${token}`, amount: '900000000' }] };
  const result = await collectVaultBalances([input], [], { now, fetchImpl: async (_url, options) => response(JSON.parse(options.body).map(r => {
    if (r.method === 'eth_blockNumber') return { id: r.id, result: '0x123' };
    if (r.method === 'eth_getBalance') return { id: r.id, result: '0x0' };
    const data = r.params[0].data;
    assert.ok(!data.startsWith(selectors.vaultAllowance));
    if (data.startsWith(selectors.balanceOf)) assert.equal(data.slice(-40), address.slice(2));
    return { id: r.id, result: data.startsWith(selectors.decimals) ? encoded(6) : encoded(0) };
  })) });
  const coin = result.vaults[0].coins.find(c => c.asset.startsWith('BASE.USDC'));
  assert.equal(coin.amount, '0');
  assert.equal(coin.balance_scope, 'address');
  assert.deepEqual(result.routerChecks, []);
});

test('unknown routers are explicitly unsupported for custody rather than guessed', async () => {
  const input = { ...vault('ETH', 'ETH.ETH', '100', address), routers: [{ chain: 'ETH', router: token }], coins: [{ asset: `ETH.USDC-${token}`, amount: '900000000' }] };
  const result = await collectVaultBalances([input], [], { now, fetchImpl: async (_url, options) => response(JSON.parse(options.body).map(r => ({ id: r.id, result: r.method === 'eth_blockNumber' ? '0x123' : encoded(6) }))) });
  const coin = result.vaults[0].coins.find(c => c.asset.startsWith('ETH.USDC'));
  assert.equal(coin.balance_status, 'unavailable');
  assert.match(coin.balance_error, /custody/);
});

test('TRON native and USDT balances have independent error handling and correct six-decimal scaling', async () => {
  const tronAddress = 'TBDVyvem1tApHbhtV9tvHTDbkPsQWw3JRM';
  const input = vault('TRON', 'TRON.TRX', '100000000', tronAddress);
  input.coins.push({ asset: 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T', amount: '900000000' });
  const result = await collectVaultBalances([input], [], { now, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('getaccount')) return response({ address: tronAddress, balance: 1234567 });
    assert.equal(body.parameter, '0000000000000000000000000dac1fb302bc428d8dc272a511e7c2f0d2a1c128');
    return response({ result: { result: true }, constant_result: [encoded(0).slice(2)] });
  } });
  assert.equal(result.vaults[0].coins[0].amount, '123456700');
  assert.equal(result.vaults[0].coins[1].amount, '0');
  assert.equal(result.vaults[0].coins[1].balance_status, 'verified');
});

test('fallback RPC results replace only failed items, preserving successful reads', async () => {
  const input = vault('ETH', 'ETH.ETH', '100', address);
  let primary = 0, alternate = 0;
  const result = await collectVaultBalances([input], [], { now, fetchImpl: async (url, options) => {
    const requests = JSON.parse(options.body);
    if (requests[0].method === 'eth_blockNumber') return response([{ id: 'block', result: '0x123' }]);
    const isPrimary = url.includes('publicnode');
    isPrimary ? primary++ : alternate++;
    return response(requests.map(r => ({ id: r.id, ...(isPrimary ? { error: { message: 'rate limit' } } : { result: '0x0' }) })));
  } });
  assert.equal(primary, 1); assert.equal(alternate, 1);
  assert.equal(result.vaults[0].coins[0].amount, '0');
  assert.equal(result.vaults[0].coins[0].balance_provider, 'eth-mainnet.public.blastapi.io');
});

test('unsafe explorer integers are rejected instead of rounding a custody balance', async () => {
  const result = await collectVaultBalances([vault('DOGE', 'DOGE.DOGE')], [], { now, fetchImpl: async () => response({ final_balance: Number.MAX_SAFE_INTEGER + 1 }) });
  assert.equal(result.vaults[0].coins[0].balance_status, 'unavailable');
});

test('an aborted collection produces unavailable checks without making network calls', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await collectVaultBalances([vault('BTC', 'BTC.BTC')], [], { now, signal: controller.signal, fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(calls, 0);
  assert.equal(result.vaults[0].coins[0].balance_status, 'unavailable');
});


test('six, eight, and eighteen decimal L1 values normalize without floating point rounding', () => {
  assert.equal(units(1_261_986_531_199n, 6), '126198653119900');
  assert.equal(units(520629375n, 8), '520629375');
  assert.equal(units(819298260000000000n, 18), '81929826');
  assert.throws(() => units('1000000', undefined), /decimals/);
});
