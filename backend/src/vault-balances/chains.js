import { createHash } from 'node:crypto';
import { fetchJson, firstProvider, getCoin, integer, observed, unavailable, units } from './common.js';
import { collectTron } from './tron.js';
import { GAIA_ASSETS } from './gaia-assets.js';

export const NATIVE_ASSETS = { BTC: 'BTC.BTC', BCH: 'BCH.BCH', LTC: 'LTC.LTC', DOGE: 'DOGE.DOGE', GAIA: 'GAIA.ATOM', SOL: 'SOL.SOL', XRP: 'XRP.XRP', TRON: 'TRON.TRX', ZEC: 'ZEC.ZEC' };
const TRON_USDT = 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T';
const host = url => new URL(url).host;
const stats = value => integer(value?.funded_txo_sum) - integer(value?.spent_txo_sum);
const sumBalance = (confirmed, pending) => {
  const sum = integer(confirmed) + integer(pending, true);
  if (sum < 0n) throw new Error('Negative address balance');
  return sum.toString();
};

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const polymod = values => values.reduce((chk, v) => {
  const top = chk >>> 25;
  chk = ((chk & 0x1ffffff) << 5) ^ v;
  for (const [i, g] of [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].entries()) if ((top >>> i) & 1) chk ^= g;
  return chk;
}, 1) >>> 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest();

// ZIP-320 TEX (bech32m, hrp "tex") wraps a P2PKH hash; explorers index the t1 form.
export function zcashTransparentAddress(address) {
  if (typeof address !== 'string') throw new Error('Invalid Zcash address');
  if (/^t1[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return address;
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) throw new Error('Mixed-case TEX address');
  const sep = lower.lastIndexOf('1');
  if (lower.slice(0, sep) !== 'tex' || lower.length - sep - 1 < 6) throw new Error('Unsupported Zcash address format');
  const data = [...lower.slice(sep + 1)].map(c => {
    const v = BECH32.indexOf(c);
    if (v < 0) throw new Error('Invalid TEX character');
    return v;
  });
  const hrp = [...'tex'].map(c => c.charCodeAt(0));
  if (polymod([...hrp.map(c => c >> 5), 0, ...hrp.map(c => c & 31), ...data]) !== 0x2bc830a3) throw new Error('Invalid TEX checksum');
  let acc = 0, bits = 0;
  const hash = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; hash.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) || hash.length !== 20) throw new Error('Invalid TEX payload');
  const payload = Buffer.from([0x1c, 0xb8, ...hash]);
  const bytes = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let n = BigInt('0x' + bytes.toString('hex')), out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

async function zcash(address, options) {
  const t1 = zcashTransparentAddress(address);
  return firstProvider(['https://blockbook.zec.zelcore.io/api/v2', 'https://api.blockchair.com/zcash'], async base => {
    if (base.includes('blockbook')) {
      const payload = await fetchJson(`${base}/address/${t1}?details=basic`, null, options);
      if (payload?.address !== t1) throw new Error('Explorer address mismatch');
      return { amount: sumBalance(payload.balance, payload.unconfirmedBalance), provider: host(base), balance_scope: 'address_with_mempool' };
    }
    const payload = await fetchJson(`${base}/dashboards/address/${t1}?limit=0`, null, options);
    if (payload?.context?.code !== 200) throw new Error('Explorer error');
    return { amount: integer(payload?.data?.[t1]?.address?.balance).toString(), provider: host(base), balance_scope: 'address' };
  }, options);
}

async function utxo(chain, address, options) {
  if (chain === 'ZEC') return zcash(address, options);
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
