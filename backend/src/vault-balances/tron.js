import { createHash } from 'node:crypto';
import { fetchJson, firstProvider, observed, unavailable, units } from './common.js';

const ENDPOINTS = ['https://tron-rpc.publicnode.com', 'https://api.trongrid.io'];
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export function tronAddressWord(address) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of address) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid TRON address');
    value = value * 58n + BigInt(digit);
  }
  const bytes = Buffer.from(value.toString(16).padStart(50, '0'), 'hex');
  const checksum = createHash('sha256').update(createHash('sha256').update(bytes.subarray(0, 21)).digest()).digest().subarray(0, 4);
  if (bytes.length !== 25 || bytes[0] !== 0x41 || !checksum.equals(bytes.subarray(21))) throw new Error('Invalid TRON address checksum');
  return bytes.subarray(1, 21).toString('hex').padStart(64, '0');
}

export async function collectTron(address, native, token, options) {
  await Promise.all([async () => {
    const result = await firstProvider(ENDPOINTS, async base => {
      const account = await fetchJson(`${base}/wallet/getaccount`, { address, visible: true }, options);
      if (account?.address !== address) throw new Error('TRON account unavailable');
      return { amount: units(account.balance ?? 0, 6), provider: new URL(base).host };
    }, options);
    observed(native, result.amount, result.provider, options);
  }, async () => {
    const parameter = tronAddressWord(address);
    const result = await firstProvider(ENDPOINTS, async base => {
      const payload = await fetchJson(`${base}/wallet/triggerconstantcontract`, {
        owner_address: address, contract_address: USDT, function_selector: 'balanceOf(address)', parameter, visible: true
      }, options);
      if (payload?.result?.result !== true || !/^[0-9a-f]{64}$/i.test(payload?.constant_result?.[0] || '')) throw new Error('TRON USDT balance unavailable');
      return { amount: units(BigInt('0x' + payload.constant_result[0]), 6), provider: new URL(base).host };
    }, options);
    observed(token, result.amount, result.provider, options);
  }].map(async (load, i) => {
    try { await load(); } catch (error) { unavailable(i ? token : native, error); }
  }));
}
