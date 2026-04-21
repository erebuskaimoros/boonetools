import { ethers } from 'ethers';

const EVM_RPC_ENDPOINTS = {
  ETH: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth-mainnet.public.blastapi.io'
  ],
  BSC: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org'
  ],
  AVAX: [
    'https://avalanche-c-chain-rpc.publicnode.com',
    'https://api.avax.network/ext/bc/C/rpc'
  ],
  BASE: [
    'https://base-rpc.publicnode.com',
    'https://mainnet.base.org'
  ]
};

const EVM_NATIVE_ASSET_BY_CHAIN = {
  ETH: 'ETH.ETH',
  BSC: 'BSC.BNB',
  AVAX: 'AVAX.AVAX',
  BASE: 'BASE.ETH'
};

const COINGECKO_NETWORK_BY_CHAIN = {
  ETH: 'ethereum',
  BSC: 'binance-smart-chain',
  AVAX: 'avalanche',
  BASE: 'base'
};

const TOKEN_PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const tokenPriceCache = new Map();

const SOL_RPC_ENDPOINTS = [
  'https://solana-rpc.publicnode.com'
];

const ERC20_INTERFACE = new ethers.Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
]);

const ETHPLORER_ADDRESS_INFO_BASE = 'https://api.ethplorer.io/getAddressInfo';
const ETHPLORER_API_KEY = 'freekey';

async function postJsonRpc(endpoints, body) {
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      }

      if (payload?.error) {
        throw new Error(payload.error.message || 'RPC request failed');
      }

      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('RPC request failed');
}

function getEvmRpcEndpoints(chain) {
  const endpoints = EVM_RPC_ENDPOINTS[chain];

  if (!endpoints?.length) {
    throw new Error(`Unsupported EVM chain for balance lookup: ${chain}`);
  }

  return endpoints;
}

function getEvmTokenDisplayName(asset) {
  return asset?.split('.')[1]?.split('-')[0] || 'TOKEN';
}

function getEvmTokenContractAddress(asset) {
  return asset?.split('-')[1] || null;
}

function getCachedTokenPrice(cacheKey) {
  const cached = tokenPriceCache.get(cacheKey);

  if (!cached || Date.now() >= cached.expiresAt) {
    tokenPriceCache.delete(cacheKey);
    return null;
  }

  return cached;
}

function setCachedTokenPrice(cacheKey, priceUsd) {
  tokenPriceCache.set(cacheKey, {
    priceUsd,
    expiresAt: Date.now() + TOKEN_PRICE_CACHE_TTL_MS
  });
}

async function fetchCoingeckoTokenPrice(chain, contractAddress) {
  const network = COINGECKO_NETWORK_BY_CHAIN[chain];
  const normalizedContract = contractAddress?.toLowerCase();

  if (!network || !normalizedContract) {
    return null;
  }

  const cacheKey = `${chain}:${normalizedContract}`;
  const cachedPrice = getCachedTokenPrice(cacheKey);

  if (cachedPrice) {
    return cachedPrice.priceUsd;
  }

  const isDev = Boolean(import.meta.env?.DEV);
  const requestUrl = isDev
    ? `/__coingecko_token_price?chain=${encodeURIComponent(chain)}&contract=${encodeURIComponent(normalizedContract)}`
    : `https://api.coingecko.com/api/v3/simple/token_price/${network}?contract_addresses=${encodeURIComponent(normalizedContract)}&vs_currencies=usd`;

  try {
    const response = await fetch(requestUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const priceUsd = isDev
      ? Number(payload?.usd ?? 0)
      : Number(payload?.[normalizedContract]?.usd ?? 0);

    const normalizedPrice = Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
    setCachedTokenPrice(cacheKey, normalizedPrice);
    return normalizedPrice;
  } catch (error) {
    console.warn(`Failed to fetch fallback token price for ${chain}:${normalizedContract}:`, error);
    setCachedTokenPrice(cacheKey, null);
    return null;
  }
}

async function postEvmJsonRpc(chain, body) {
  return postJsonRpc(getEvmRpcEndpoints(chain), body);
}

async function callEvmContract(chain, contractAddress, fragment, params = []) {
  const data = ERC20_INTERFACE.encodeFunctionData(fragment, params);
  const result = await postEvmJsonRpc(chain, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      {
        to: contractAddress,
        data
      },
      'latest'
    ]
  });

  if (!result || result === '0x') {
    return null;
  }

  const [decodedResult] = ERC20_INTERFACE.decodeFunctionResult(fragment, result);
  return decodedResult;
}

async function fetchEvmNativeBalance(chain, address) {
  const result = await postEvmJsonRpc(chain, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getBalance',
    params: [address, 'latest']
  });

  return Number(ethers.formatEther(result));
}

async function fetchErc20BalanceRaw(chain, contractAddress, address) {
  const balance = await callEvmContract(chain, contractAddress, 'balanceOf', [address]);
  return balance == null ? 0n : BigInt(balance);
}

async function fetchErc20Decimals(chain, contractAddress) {
  const decimals = await callEvmContract(chain, contractAddress, 'decimals');
  return decimals == null ? 18 : Number(decimals);
}

function getEthTokenAsset(tokenInfo) {
  const symbol = tokenInfo?.symbol || tokenInfo?.name || 'TOKEN';
  const contractAddress = tokenInfo?.address?.toUpperCase();
  return contractAddress ? `ETH.${symbol}-${contractAddress}` : `ETH.${symbol}`;
}

async function fetchEthAddressInfo(address) {
  const response = await fetch(
    `${ETHPLORER_ADDRESS_INFO_BASE}/${address}?apiKey=${ETHPLORER_API_KEY}`
  );

  if (!response.ok) {
    throw new Error(`ETH token balance lookup failed: HTTP ${response.status}`);
  }

  return response.json();
}

export async function fetchEthHoldings(address) {
  const payload = await fetchEthAddressInfo(address);
  const nativeAmount = Number(payload?.ETH?.balance || 0);
  const nativeRate = Number(payload?.ETH?.price?.rate || 0);

  const nativeHolding = {
    asset: 'ETH.ETH',
    chain: 'ETH',
    amount: nativeAmount,
    usdValue: nativeRate > 0 ? nativeAmount * nativeRate : null,
    displayName: 'ETH'
  };

  const tokenHoldings = (payload?.tokens || [])
    .map((token) => {
      const rawBalance = token?.rawBalance;
      const decimals = Number(token?.tokenInfo?.decimals || 0);
      if (!rawBalance) return null;

      const amount = Number(ethers.formatUnits(rawBalance, decimals));
      if (!Number.isFinite(amount) || amount <= 0) return null;

      const priceRate = Number(token?.tokenInfo?.price?.rate || 0);
      const symbol = token?.tokenInfo?.symbol || token?.tokenInfo?.name || 'TOKEN';
      const contractAddress = token?.tokenInfo?.address?.toUpperCase() || null;

      return {
        asset: getEthTokenAsset(token?.tokenInfo),
        chain: 'ETH',
        amount,
        usdValue: priceRate > 0 ? amount * priceRate : null,
        displayName: symbol,
        contractAddress
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftValue = left.usdValue || 0;
      const rightValue = right.usdValue || 0;
      if (rightValue !== leftValue) {
        return rightValue - leftValue;
      }
      return right.amount - left.amount;
    });

  return [nativeHolding, ...tokenHoldings];
}

export async function fetchEvmChainHoldings(address, chain, trackedAssets = []) {
  const holdings = [];
  const nativeAsset = EVM_NATIVE_ASSET_BY_CHAIN[chain];
  const nativeAmount = await fetchEvmNativeBalance(chain, address);

  if (nativeAsset && nativeAmount > 0) {
    holdings.push({
      asset: nativeAsset,
      chain,
      amount: nativeAmount
    });
  }

  const uniqueTrackedAssets = [...new Set(
    trackedAssets.filter((asset) => asset?.startsWith(`${chain}.`) && asset.includes('-0X'))
  )];

  const tokenHoldings = await Promise.all(
    uniqueTrackedAssets.map(async (asset) => {
      const contractAddress = getEvmTokenContractAddress(asset);
      if (!contractAddress) return null;

      try {
        const rawBalance = await fetchErc20BalanceRaw(chain, contractAddress, address);
        if (rawBalance <= 0n) return null;

        const decimals = await fetchErc20Decimals(chain, contractAddress);
        const amount = Number(ethers.formatUnits(rawBalance, decimals));
        if (!Number.isFinite(amount) || amount <= 0) return null;

        return {
          asset,
          chain,
          amount,
          displayName: getEvmTokenDisplayName(asset),
          contractAddress
        };
      } catch (error) {
        console.warn(`Failed to fetch ${asset} balance on ${chain}:`, error);
        return null;
      }
    })
  );

  return [...holdings, ...tokenHoldings.filter(Boolean)].sort((left, right) => right.amount - left.amount);
}

export async function fetchEthBalance(address) {
  return fetchEvmNativeBalance('ETH', address);
}

export async function fetchBtcBalance(address) {
  const response = await fetch(`https://mempool.space/api/address/${address}`);

  if (response.status === 404) {
    return 0;
  }

  if (!response.ok) {
    throw new Error(`BTC balance lookup failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const chainStats = payload?.chain_stats || {};
  const funded = Number(chainStats.funded_txo_sum || 0);
  const spent = Number(chainStats.spent_txo_sum || 0);

  return (funded - spent) / 1e8;
}

export async function fetchSolBalance(address) {
  const result = await postJsonRpc(SOL_RPC_ENDPOINTS, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: [address]
  });

  return Number(result?.value || 0) / 1e9;
}

export async function fetchTronBalance(address) {
  const response = await fetch(`https://api.trongrid.io/v1/accounts/${address}`);

  if (response.status === 404) {
    return 0;
  }

  if (!response.ok) {
    throw new Error(`TRON balance lookup failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const balance = Number(payload?.data?.[0]?.balance || 0);

  return balance / 1e6;
}

export async function fetchNativeBalance(entry) {
  switch (entry.chain) {
    case 'ETH':
      return fetchEthBalance(entry.address);
    case 'BSC':
    case 'AVAX':
    case 'BASE':
      return fetchEvmNativeBalance(entry.chain, entry.address);
    case 'BTC':
      return fetchBtcBalance(entry.address);
    case 'SOL':
      return fetchSolBalance(entry.address);
    case 'TRON':
      return fetchTronBalance(entry.address);
    default:
      throw new Error(`Unsupported chain for native balance lookup: ${entry.chain}`);
  }
}

export async function hydrateMissingEvmTokenPrices(holdings = []) {
  const indexedPrices = await Promise.all(
    holdings.map(async (holding) => {
      if (holding?.usdValue != null || !holding?.contractAddress) {
        return null;
      }

      const priceUsd = await fetchCoingeckoTokenPrice(holding.chain, holding.contractAddress);
      if (priceUsd == null) {
        return null;
      }

      return {
        asset: holding.asset,
        priceUsd
      };
    })
  );

  const priceByAsset = indexedPrices.reduce((map, item) => {
    if (item?.asset) {
      map.set(item.asset, item.priceUsd);
    }
    return map;
  }, new Map());

  return holdings.map((holding) => {
    if (holding?.usdValue != null) {
      return holding;
    }

    const priceUsd = priceByAsset.get(holding.asset);
    if (priceUsd == null) {
      return holding;
    }

    return {
      ...holding,
      usdValue: holding.amount * priceUsd
    };
  });
}
