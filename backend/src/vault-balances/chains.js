import { fetchJson, firstProvider, getCoin, integer, observed, unavailable, units } from './common.js';
import { collectTron } from './tron.js';
import { GAIA_ASSETS } from './gaia-assets.js';

export const NATIVE_ASSETS = { BTC: 'BTC.BTC', BCH: 'BCH.BCH', LTC: 'LTC.LTC', DOGE: 'DOGE.DOGE', GAIA: 'GAIA.ATOM', SOL: 'SOL.SOL', XRP: 'XRP.XRP', TRON: 'TRON.TRX' };
const TRON_USDT = 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T';
const host = url => new URL(url).host;
const stats = value => integer(value?.funded_txo_sum) - integer(value?.spent_txo_sum);
const sumBalance = (confirmed, pending) => {
  const sum = integer(confirmed) + integer(pending, true);
  if (sum < 0n) throw new Error('Negative address balance');
  return sum.toString();
};

async function utxo(chain, address, options) {
  const encoded = encodeURIComponent(address);
  if (chain === 'BTC' || chain === 'LTC') {
    const endpoints = chain === 'BTC' ? ['https://blockstream.info/api', 'https://mempool.space/api'] : ['https://litecoinspace.org/api', 'https://api.blockcypher.com/v1/ltc/main'];
    return firstProvider(endpoints, async base => {
      if (base.includes('blockcypher')) {
        const payload = await fetchJson(`${base}/addrs/${encoded}/balance`, null, options);
        return { amount: integer(payload?.final_balance).toString(), provider: host(base), balance_scope: 'address_with_mempool' };
      }
      const payload = await fetchJson(`${base}/address/${encoded}`, null, options);
      const amount = stats(payload?.chain_stats) + stats(payload?.mempool_stats);
      if (amount < 0n) throw new Error('Negative address balance');
      return { amount: amount.toString(), provider: host(base), balance_scope: 'address_with_mempool' };
    }, options);
  }
  if (chain === 'BCH') {
    return firstProvider(['https://api.haskoin.com/bch', 'https://api.blockchain.info/haskoin-store/bch'], async base => {
      const payload = await fetchJson(`${base}/address/${encoded}/balance`, null, options);
      return { amount: sumBalance(payload?.confirmed, payload?.unconfirmed), provider: host(base), balance_scope: 'address_with_mempool' };
    }, options);
  }
  return firstProvider(['https://api.blockcypher.com/v1/doge/main', 'https://api.blockchair.com/dogecoin'], async base => {
    if (base.includes('blockcypher')) {
      const payload = await fetchJson(`${base}/addrs/${encoded}/balance`, null, options);
      return { amount: integer(payload?.final_balance).toString(), provider: host(base), balance_scope: 'address_with_mempool' };
    }
    const payload = await fetchJson(`${base}/dashboards/address/${encoded}`, null, options);
    if (payload?.context?.code !== 200) throw new Error('Explorer error');
    return { amount: integer(payload?.data?.[address]?.address?.balance).toString(), provider: host(base), balance_scope: 'address' };
  }, options);
}

async function cosmos(address, options) {
  return firstProvider(['https://rest.cosmos.directory/cosmoshub', 'https://cosmos-rest.publicnode.com'], async base => {
    const balances = new Map();
    const keys = new Set();
    let key = '';
    do {
      if (keys.size >= 20 || keys.has(key)) throw new Error('Incomplete Cosmos balance pagination');
      keys.add(key);
      const payload = await fetchJson(`${base}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}?pagination.limit=100${key ? `&pagination.key=${encodeURIComponent(key)}` : ''}`, null, options);
      if (!Array.isArray(payload?.balances) || !payload.pagination || !Object.hasOwn(payload.pagination, 'next_key')) throw new Error('Invalid Cosmos balances');
      for (const coin of payload.balances) {
        if (typeof coin.denom !== 'string') throw new Error('Missing Cosmos denomination');
        balances.set(coin.denom, integer(coin.amount));
      }
      key = payload.pagination.next_key;
    } while (key);
    return { balances, provider: host(base) };
  }, options);
}

async function rpcBalance(chain, address, options) {
  const endpoints = chain === 'SOL' ? ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'] : ['https://xrplcluster.com', 'https://s1.ripple.com:51234'];
  return firstProvider(endpoints, async endpoint => {
    const payload = await fetchJson(endpoint, chain === 'SOL'
      ? { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address, { commitment: 'confirmed' }] }
      : { method: 'account_info', params: [{ account: address, ledger_index: 'validated' }] }, options);
    const result = payload?.result;
    if (chain === 'SOL') {
      if (payload?.error || !Number.isSafeInteger(result?.context?.slot)) throw new Error('Invalid Solana response');
      return { amount: units(result.value, 9), provider: host(endpoint), balance_block: String(result.context.slot) };
    }
    if (result?.validated !== true || !Number.isSafeInteger(result?.ledger_index)) throw new Error('XRP ledger is not validated');
    if (result.error && result.error !== 'actNotFound') throw new Error(result.error);
    return { amount: units(result.error === 'actNotFound' ? '0' : result.account_data?.Balance, 6), provider: host(endpoint), balance_block: String(result.ledger_index) };
  }, options);
}

export async function collectAddress(chain, vault, address, options) {
  const native = getCoin(vault, NATIVE_ASSETS[chain]);
  const targets = chain === 'GAIA' ? Object.keys(GAIA_ASSETS).map(asset => getCoin(vault, asset))
    : chain === 'TRON' ? [native, getCoin(vault, TRON_USDT)] : [native];
  try {
    if (chain === 'GAIA') {
      const result = await cosmos(address, options);
      for (const coin of targets) {
        const { denom, decimals } = GAIA_ASSETS[coin.asset];
        observed(coin, units(result.balances.get(denom) ?? 0n, decimals), result.provider, options);
      }
    } else if (chain === 'TRON') {
      await collectTron(address, native, targets[1], options);
    } else {
      const { amount, provider, ...metadata } = ['SOL', 'XRP'].includes(chain)
        ? await rpcBalance(chain, address, options) : await utxo(chain, address, options);
      observed(native, amount, provider, options, metadata);
    }
  } catch (error) {
    for (const coin of targets) unavailable(coin, error);
  }
}
