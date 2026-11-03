import { base58, base58xrp, bech32, bech32m, createBase58check } from '@scure/base';

// Only expose chains whose mainnet receiving addresses we can validate locally.
const CHAINS = new Set(['THOR', 'BTC', 'BCH', 'LTC', 'DOGE', 'ETH', 'AVAX', 'BSC', 'BASE', 'GAIA', 'TRON', 'XRP', 'SOL', 'ZEC']);
const EVM = new Set(['ETH', 'AVAX', 'BSC', 'BASE']);

export function bondYieldAsset(value) {
  const asset = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]+\.[A-Z0-9][A-Z0-9._-]*$/.test(asset) || !CHAINS.has(asset.split('.')[0]) || asset === 'THOR.RUNE') {
    throw new Error('Choose a supported pool asset for the payout.');
  }
  return asset;
}

export function bondYieldAssetOptions(pools = []) {
  return [...new Set(pools.filter((pool) => pool?.status === 'Available').flatMap((pool) => {
    try { return [bondYieldAsset(pool.asset)]; } catch { return []; }
  }))].sort();
}

/** Validate checksums and mainnet networks without connecting to a wallet. */
export async function bondYieldAssetAddress(asset, value) {
  const chain = bondYieldAsset(asset).split('.')[0];
  let address = String(value || '').trim();
  if (chain === 'BCH') address = address.replace(/^bitcoincash:/i, '');
  if (!address || /[\s:/]/.test(address)) throw new Error(`Enter a valid mainnet ${chain} receiving address.`);
  let valid = false;
  try {
    if (EVM.has(chain)) {
      const { isAddress } = await import('ethers');
      valid = isAddress(address) && !/^0x0{40}$/i.test(address);
    } else if (chain === 'THOR' || chain === 'GAIA') {
      const decoded = bech32.decodeToBytes(address);
      valid = decoded.prefix === (chain === 'THOR' ? 'thor' : 'cosmos') && decoded.bytes.length === 20;
      address = address.toLowerCase();
    } else if (['BTC', 'BCH', 'LTC', 'DOGE'].includes(chain)) {
      if (chain === 'BCH' && /^[qp]/i.test(address)) {
        const { default: cashaddr } = await import('cashaddrjs');
        const prefix = address === address.toUpperCase() ? 'BITCOINCASH' : 'bitcoincash';
        const decoded = cashaddr.decode(`${prefix}:${address}`);
        valid = decoded.prefix.toLowerCase() === 'bitcoincash' && decoded.hash.length === 20;
        address = address.toLowerCase();
      } else {
        const { address: btcAddress, networks } = await import('bitcoinjs-lib');
        const network = chain === 'LTC' ? { ...networks.bitcoin, bech32: 'ltc', pubKeyHash: 48, scriptHash: 50 }
          : chain === 'DOGE' ? { ...networks.bitcoin, bech32: '', pubKeyHash: 30, scriptHash: 22 } : networks.bitcoin;
        // BCH uses legacy Base58 or CashAddr, never Bitcoin witness addresses.
        if (chain !== 'BCH' || /^[13]/.test(address)) {
          // Litecoin retains legacy P2SH addresses starting with 3 alongside M.
          btcAddress.toOutputScript(address, chain === 'LTC' && address.startsWith('3') ? { ...network, scriptHash: 5 } : network);
          valid = true;
        }
      }
    } else if (chain === 'ZEC' || chain === 'TRON' || chain === 'XRP') {
      const { sha256, getBytes } = await import('ethers');
      const hash = (bytes) => getBytes(sha256(bytes));
      if (chain === 'ZEC' && address.startsWith('tex1')) {
        const decoded = bech32m.decodeToBytes(address);
        valid = decoded.prefix === 'tex' && decoded.bytes.length === 20;
      } else if (chain === 'XRP') {
        const decoded = base58xrp.decode(address);
        const payload = decoded.slice(0, -4);
        const checksum = hash(hash(payload)).slice(0, 4);
        valid = decoded.length === 25 && payload[0] === 0 && checksum.every((byte, index) => byte === decoded[21 + index]);
      } else {
        const payload = createBase58check(hash).decode(address);
        valid = chain === 'TRON' ? payload.length === 21 && payload[0] === 0x41
          : payload.length === 22 && payload[0] === 0x1c && [0xb8, 0xbd].includes(payload[1]);
      }
    } else if (chain === 'SOL') {
      valid = base58.decode(address).length === 32;
    }
  } catch { valid = false; }
  if (!valid) throw new Error(`Enter a valid mainnet ${chain} receiving address.`);
  return address;
}
