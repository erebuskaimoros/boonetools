import { config } from '../lib/config.js';
import { fetchMidgard } from '../shared/midgard.js';
import { fetchThorchain } from '../shared/thornode.js';
import { isThorNodeCoreSnapshotStale } from '../shared/thornode-core-snapshot.js';
import { loadAcquisition, saveAcquisition } from '../shared/acquisition-cache.js';

const REQUEST_TIMEOUT_MS = 6_000;
const EVM_RPC_ENDPOINTS = Object.freeze({
  ETH: Object.freeze([
    'https://ethereum-rpc.publicnode.com',
    'https://eth-mainnet.public.blastapi.io'
  ]),
  BSC: Object.freeze([
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org'
  ]),
  AVAX: Object.freeze([
    'https://avalanche-c-chain-rpc.publicnode.com',
    'https://api.avax.network/ext/bc/C/rpc'
  ]),
  BASE: Object.freeze([
    'https://base-rpc.publicnode.com',
    'https://mainnet.base.org'
  ])
});

const COINGECKO_NETWORK_BY_CHAIN = Object.freeze({
  ETH: 'ethereum',
  BSC: 'binance-smart-chain',
  AVAX: 'avalanche',
  BASE: 'base'
});

function message(error) {
  return error?.message || String(error || 'unknown error');
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const input = Array.isArray(items) ? items : [];
  if (input.length === 0) return [];
  const results = new Array(input.length);
  let index = 0;

  async function run() {
    while (index < input.length) {
      const current = index++;
      results[current] = await worker(input[current], current);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Math.trunc(concurrency) || 1), input.length) },
    run
  ));
  return results;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl || globalThis.fetch)(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Invalid JSON from ${url}`);
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.error || `HTTP ${response.status} for ${url}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirstJson(urls, options = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No provider URLs configured');
}

function settled(name, result) {
  return result.status === 'fulfilled'
    ? { ok: true, name, value: result.value }
    : { ok: false, name, error: message(result.reason) };
}

export async function fetchTreasuryCore(options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const shared = options.coreSnapshot?.payload || options.coreSnapshot || null;
  const sharedStale = isThorNodeCoreSnapshotStale(
    options.coreSnapshot,
    ['network', 'pools', 'nodes']
  );
  const requests = shared
    ? [['module', '/thorchain/balance/module/treasury']]
    : [
        ['network', '/thorchain/network'],
        ['pools', '/thorchain/pools'],
        ['nodes', '/thorchain/nodes'],
        ['module', '/thorchain/balance/module/treasury']
      ];
  const results = await Promise.allSettled(requests.map(([, path]) => fetchThor(path, {
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
    cooldownClient: options.cooldownClient
  })));
  const output = Object.fromEntries(results.map((result, index) => [
    requests[index][0],
    settled(requests[index][0], result)
  ]));
  if (shared) {
    for (const key of ['network', 'pools', 'nodes']) {
      const valid = key === 'network'
        ? Boolean(shared[key]) && typeof shared[key] === 'object' && !Array.isArray(shared[key])
        : Array.isArray(shared[key]);
      output[key] = valid && !sharedStale
        ? { ok: true, name: key, value: shared[key], shared: true }
        : { ok: false, name: key, error: `shared THORNode ${key} snapshot is unavailable or stale` };
    }
  }
  return output;
}

export async function fetchThorBalance(address, options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const payload = await fetchThor(`/cosmos/bank/v1beta1/balances/${address}`, {
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS
  });
  return Array.isArray(payload?.balances) ? payload.balances : [];
}

export async function fetchTcyStaker(address, options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  try {
    const payload = await fetchThor(`/thorchain/tcy_staker/${address}`, {
      timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS
    });
    return {
      address: payload?.address || address,
      amount: String(payload?.amount || '0')
    };
  } catch (error) {
    if (Number(error?.status) === 404 || /404|not found/i.test(message(error))) {
      return { address, amount: '0' };
    }
    throw error;
  }
}

export async function fetchMemberPoolAssets(address, options = {}) {
  const fetchMember = options.fetchMidgard || fetchMidgard;
  const payload = await fetchMember(`/member/${address}`, {
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
    validateResponse: (_path, value) => !Array.isArray(value?.pools)
  });
  return [...new Set((payload?.pools || [])
    .filter((position) => Number(position?.liquidityUnits || 0) > 0)
    .map((position) => String(position.pool || ''))
    .filter(Boolean))];
}

export async function fetchLiquidityProvider(asset, address, options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  try {
    return await fetchThor(
      `/thorchain/pool/${encodeURIComponent(asset)}/liquidity_provider/${address}`,
      { timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS }
    );
  } catch (error) {
    if (Number(error?.status) === 404 || /404|not found/i.test(message(error))) return null;
    throw error;
  }
}

function normalizeContract(asset) {
  const contract = String(asset || '').split('-')[1] || '';
  return contract.startsWith('0X') || contract.startsWith('0x')
    ? `0x${contract.slice(2).toLowerCase()}`
    : contract.toLowerCase();
}

function displayName(asset) {
  return String(asset || '').split('.')[1]?.split('-')[0] || 'TOKEN';
}

function addressWord(address) {
  return String(address || '').replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function decodeRpcQuantity(value, fallback = 0n) {
  try {
    return value == null || value === '0x' ? fallback : BigInt(value);
  } catch {
    return fallback;
  }
}

function formatUnits(value, decimals) {
  const safeDecimals = Math.max(0, Math.min(36, Math.trunc(Number(decimals) || 0)));
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(safeDecimals + 1, '0');
  const whole = safeDecimals ? digits.slice(0, -safeDecimals) : digits;
  const fraction = safeDecimals ? digits.slice(-safeDecimals).replace(/0+$/, '') : '';
  return Number(`${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`);
}

async function postRpcBatch(chain, calls, options = {}) {
  const endpoints = options.rpcEndpoints?.[chain] || EVM_RPC_ENDPOINTS[chain] || [];
  const payload = await fetchFirstJson(endpoints, {
    method: 'POST',
    body: calls.map((call, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: call.method,
      params: call.params
    })),
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  if (!Array.isArray(payload)) throw new Error(`${chain} RPC did not accept a batch request`);
  const byId = new Map(payload.map((row) => [Number(row?.id), row]));
  return calls.map((call, index) => {
    const row = byId.get(index + 1);
    if (!row || row.error) throw new Error(row?.error?.message || `${chain} RPC call ${call.key} failed`);
    return row.result;
  });
}

export async function fetchEvmChainHoldings(address, chain, trackedAssets = [], options = {}) {
  const assets = [...new Set(trackedAssets)].filter((asset) => normalizeContract(asset));
  const nowMs = Number(options.nowMs ?? Date.now());
  const client = options.cooldownClient;
  const decimalsByContract = new Map();
  for (const asset of assets) {
    const contract = normalizeContract(asset);
    const cached = await loadAcquisition(client, 'evm-token-decimals:v1', { chain, contract }, { nowMs });
    if (Number.isInteger(cached?.payload) && cached.payload >= 0 && cached.payload <= 36) {
      decimalsByContract.set(contract, cached.payload);
    }
  }
  const calls = [{ key: 'native', method: 'eth_getBalance', params: [address, 'latest'] }];
  for (const asset of assets) {
    const contract = normalizeContract(asset);
    calls.push({
      key: `${asset}:balance`,
      method: 'eth_call',
      params: [{ to: contract, data: `0x70a08231${addressWord(address)}` }, 'latest']
    });
    if (!decimalsByContract.has(contract)) calls.push({
      key: `${asset}:decimals`,
      method: 'eth_call',
      params: [{ to: contract, data: '0x313ce567' }, 'latest']
    });
  }

  const results = await postRpcBatch(chain, calls, options);
  const byKey = new Map(calls.map((call, index) => [call.key, results[index]]));
  const holdings = [];
  const nativeAmount = formatUnits(decodeRpcQuantity(results[0]), 18);
  const nativeAsset = { ETH: 'ETH.ETH', BSC: 'BSC.BNB', AVAX: 'AVAX.AVAX', BASE: 'BASE.ETH' }[chain];
  if (nativeAsset && nativeAmount > 0) holdings.push({ asset: nativeAsset, chain, amount: nativeAmount });

  for (const asset of assets) {
    const contract = normalizeContract(asset);
    const balance = decodeRpcQuantity(byKey.get(`${asset}:balance`));
    if (!decimalsByContract.has(contract)) {
      const raw = byKey.get(`${asset}:decimals`);
      if (!/^0x[0-9a-f]+$/i.test(String(raw))) throw new Error(`Invalid ${chain} token decimals`);
      const decimals = Number(BigInt(raw));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Invalid ${chain} token decimals`);
      decimalsByContract.set(contract, decimals);
      await saveAcquisition(client, { namespace: 'evm-token-decimals:v1', identity: { chain, contract },
        payload: decimals, source: `${chain}:eth_call`, observedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 86_400_000).toISOString() });
    }
    const decimals = decimalsByContract.get(contract);
    const amount = formatUnits(balance, decimals);
    if (!(amount > 0)) continue;
    holdings.push({
      asset,
      chain,
      amount,
      displayName: displayName(asset),
      contractAddress: normalizeContract(asset)
    });
  }

  return holdings;
}

export async function fetchEthplorerHoldings(address, options = {}) {
  const apiKey = process.env.ETHPLORER_API_KEY || 'freekey';
  const baseUrl = process.env.ETHPLORER_ADDRESS_INFO_BASE || 'https://api.ethplorer.io/getAddressInfo';
  const payload = await fetchJson(`${baseUrl}/${address}?apiKey=${encodeURIComponent(apiKey)}`, {
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  const nativeAmount = Number(payload?.ETH?.balance || 0);
  const nativeRate = Number(payload?.ETH?.price?.rate || 0);
  const holdings = [{
    asset: 'ETH.ETH',
    chain: 'ETH',
    amount: nativeAmount,
    usdValue: nativeRate > 0 ? nativeAmount * nativeRate : null,
    displayName: 'ETH'
  }];

  for (const token of payload?.tokens || []) {
    const rawBalance = decodeRpcQuantity(token?.rawBalance?.startsWith?.('0x')
      ? token.rawBalance
      : `0x${BigInt(token?.rawBalance || 0).toString(16)}`);
    const decimals = Number(token?.tokenInfo?.decimals || 0);
    const amount = formatUnits(rawBalance, decimals);
    if (!(amount > 0)) continue;
    const symbol = token?.tokenInfo?.symbol || token?.tokenInfo?.name || 'TOKEN';
    const contractAddress = token?.tokenInfo?.address
      ? `0x${String(token.tokenInfo.address).replace(/^0x/i, '').toLowerCase()}`
      : null;
    const priceRate = Number(token?.tokenInfo?.price?.rate || 0);
    holdings.push({
      asset: contractAddress ? `ETH.${symbol}-${contractAddress.toUpperCase()}` : `ETH.${symbol}`,
      chain: 'ETH',
      amount,
      usdValue: priceRate > 0 ? amount * priceRate : null,
      displayName: symbol,
      contractAddress
    });
  }
  return holdings;
}

export async function fetchBtcHolding(address, options = {}) {
  const payload = await fetchJson(`https://mempool.space/api/address/${address}`, {
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  const stats = payload?.chain_stats || {};
  return [{
    asset: 'BTC.BTC',
    chain: 'BTC',
    amount: (Number(stats.funded_txo_sum || 0) - Number(stats.spent_txo_sum || 0)) / 1e8
  }];
}

export async function fetchSolHolding(address, options = {}) {
  const payload = await fetchFirstJson(['https://solana-rpc.publicnode.com'], {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] },
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  if (payload?.error) throw new Error(payload.error.message || 'Solana RPC failed');
  return [{ asset: 'SOL.SOL', chain: 'SOL', amount: Number(payload?.result?.value || 0) / 1e9 }];
}

export async function fetchTronHolding(address, options = {}) {
  const payload = await fetchJson(`https://api.trongrid.io/v1/accounts/${address}`, {
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  return [{ asset: 'TRON.TRX', chain: 'TRON', amount: Number(payload?.data?.[0]?.balance || 0) / 1e6 }];
}

export async function fetchExternalHoldings(entry, trackedAssetsByChain = {}, options = {}) {
  if (entry.chain === 'ETH' && entry.includeTokenBalances) {
    const results = await Promise.all([
      fetchEthplorerHoldings(entry.address, options),
      mapWithConcurrency(entry.includeEvmChainBalances || [], 3, (chain) =>
        fetchEvmChainHoldings(entry.address, chain, trackedAssetsByChain[chain] || [], options))
    ]);
    return [...results[0], ...results[1].flat()];
  }
  if (entry.chain === 'BTC') return fetchBtcHolding(entry.address, options);
  if (entry.chain === 'SOL') return fetchSolHolding(entry.address, options);
  if (entry.chain === 'TRON') return fetchTronHolding(entry.address, options);
  if (EVM_RPC_ENDPOINTS[entry.chain]) {
    return fetchEvmChainHoldings(entry.address, entry.chain, trackedAssetsByChain[entry.chain] || [], options);
  }
  throw new Error(`Unsupported external treasury chain: ${entry.chain}`);
}

export async function fetchTokenPrices(holdings = [], options = {}) {
  const requests = new Map();
  for (const holding of holdings) {
    if (holding?.usdValue != null || !holding?.contractAddress) continue;
    const network = COINGECKO_NETWORK_BY_CHAIN[holding.chain];
    const contract = String(holding.contractAddress).toLowerCase();
    if (!network || !contract) continue;
    const group = requests.get(holding.chain) || new Set();
    group.add(contract);
    requests.set(holding.chain, group);
  }

  const priceEntries = await mapWithConcurrency([...requests.entries()], 2, async ([chain, contracts]) => {
    const network = COINGECKO_NETWORK_BY_CHAIN[chain];
    const contractList = [...contracts];
    const url = `https://api.coingecko.com/api/v3/simple/token_price/${network}`
      + `?contract_addresses=${encodeURIComponent(contractList.join(','))}&vs_currencies=usd`;
    const payload = await fetchJson(url, {
      timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
      fetchImpl: options.fetchImpl
    });
    return contractList.map((contract) => [`${chain}:${contract}`, Number(payload?.[contract]?.usd || 0)]);
  });
  return Object.fromEntries(priceEntries.flat().filter(([, price]) => price > 0));
}

export function providerConfiguration() {
  return {
    thornode: [config.thornodePrimaryUrl, config.thornodeFallbackUrl],
    midgard: [config.midgardUrl, config.midgardFallbackUrl],
    timeoutMs: REQUEST_TIMEOUT_MS
  };
}
