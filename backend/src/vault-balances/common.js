export const BALANCE_TTL_MS = 90_000;

// Refuse rounded JSON numbers and missing fields: neither is evidence of zero.
export function integer(value, signed = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe balance integer');
  if (!new RegExp(signed ? '^-?\\d+$' : '^\\d+$').test(String(value))) throw new Error('Missing or invalid balance');
  return BigInt(value);
}

export function units(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid token decimals');
  return (integer(value) * 100000000n / 10n ** BigInt(decimals)).toString();
}

export function rpcInteger(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid RPC quantity');
  return BigInt(value);
}

export function getCoin(vault, asset) {
  let coin = vault.coins.find(c => c.asset.toUpperCase() === asset.toUpperCase());
  if (!coin) {
    coin = { asset, amount: '0', thornode_amount: null, balance_status: 'unsupported' };
    vault.coins.push(coin);
  }
  return coin;
}

export function unavailable(coin, error) {
  coin.balance_status = 'unavailable';
  coin.balance_error = error?.message || String(error);
}

export function observed(coin, amount, provider, options, metadata = {}) {
  coin.amount = integer(amount).toString();
  coin.balance_status = 'verified';
  coin.balance_provider = provider;
  coin.balance_scope = 'address';
  coin.balance_observed_at = new Date(options.now ?? Date.now()).toISOString();
  coin.balance_expires_at = new Date(Date.parse(coin.balance_observed_at) + BALANCE_TTL_MS).toISOString();
  delete coin.balance_error;
  Object.assign(coin, metadata);
}

export async function mapLimit(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

export async function fetchJson(url, body, options) {
  options.signal?.throwIfAborted();
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 6000), ...(options.signal ? [options.signal] : [])]);
  const response = await (options.fetchImpl || fetch)(url, {
    signal,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.json();
}

export async function firstProvider(endpoints, load, options) {
  let lastError;
  for (const endpoint of endpoints) {
    options.signal?.throwIfAborted();
    try { return await load(endpoint); } catch (error) { lastError = error; }
  }
  throw lastError || new Error('No L1 provider available');
}
