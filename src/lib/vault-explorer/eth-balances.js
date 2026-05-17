import { ethers } from 'ethers';

const ETH_RPC_ENDPOINTS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth-mainnet.public.blastapi.io'
];

const ETH_NATIVE_ASSET = 'ETH.ETH';
const THORCHAIN_BASE = 100000000n;
const DEFAULT_TOKEN_DECIMALS = 18;

const ERC20_INTERFACE = new ethers.Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
]);

const ROUTER_INTERFACE = new ethers.Interface([
  'function vaultAllowance(address vault, address token) view returns (uint256)'
]);

export function isEthTokenAsset(asset) {
  return typeof asset === 'string' && asset.startsWith('ETH.') && /-0x[a-f0-9]+$/i.test(asset);
}

export function getEthTokenContractAddress(asset) {
  const contractAddress = isEthTokenAsset(asset) ? asset.split('-')[1] : null;
  return contractAddress ? contractAddress.toLowerCase() : null;
}

export function toThorchainBaseAmount(rawBalance, decimals = DEFAULT_TOKEN_DECIMALS) {
  const safeDecimals = Number.isFinite(decimals) && decimals >= 0 ? Math.trunc(decimals) : DEFAULT_TOKEN_DECIMALS;
  const divisor = 10n ** BigInt(safeDecimals);
  return ((BigInt(rawBalance || 0) * THORCHAIN_BASE) / divisor).toString();
}

function getVaultEthAddress(vault) {
  return vault?.addresses?.find((entry) => entry.chain === 'ETH')?.address || null;
}

function getVaultEthRouter(vault, inboundAddresses) {
  return vault?.routers?.find((entry) => entry.chain === 'ETH')?.router
    || inboundAddresses?.find((entry) => entry.chain === 'ETH')?.router
    || null;
}

function getExistingCoin(vault, asset) {
  return vault?.coins?.find((coin) => coin.asset === asset) || null;
}

function buildEthCall(to, data) {
  return {
    to,
    data
  };
}

async function postJsonRpcBatch(requests) {
  let lastError = null;

  for (const endpoint of ETH_RPC_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(requests)
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!Array.isArray(payload)) {
        throw new Error('Unexpected JSON-RPC batch response');
      }

      return new Map(payload.map((entry) => [entry.id, entry]));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Ethereum RPC batch failed');
}

function decodeFunctionResult(contractInterface, fragment, result) {
  if (!result || result === '0x') return null;
  const [decoded] = contractInterface.decodeFunctionResult(fragment, result);
  return decoded;
}

function addOrUpdateCoin(coins, asset, baseAmount, metadata = {}) {
  const existingIndex = coins.findIndex((coin) => coin.asset === asset);
  const existing = existingIndex >= 0 ? coins[existingIndex] : null;
  const next = {
    ...(existing || { asset }),
    ...metadata,
    asset,
    amount: baseAmount
  };

  if (existingIndex >= 0) {
    coins[existingIndex] = next;
  } else if (BigInt(baseAmount) > 0n) {
    coins.push(next);
  }
}

export async function hydrateEthOnChainBalances(rawVaults, poolsData, inboundAddresses) {
  const vaults = rawVaults.map((vault) => ({
    ...vault,
    addresses: [...(vault.addresses || [])],
    routers: [...(vault.routers || [])],
    coins: (vault.coins || []).map((coin) => ({ ...coin }))
  }));

  const ethTokenAssets = new Set();
  for (const pool of poolsData || []) {
    if (isEthTokenAsset(pool.asset)) ethTokenAssets.add(pool.asset);
  }
  for (const vault of vaults) {
    for (const coin of vault.coins || []) {
      if (isEthTokenAsset(coin.asset)) ethTokenAssets.add(coin.asset);
    }
  }

  const tokenAssets = [...ethTokenAssets];
  const requests = [];
  const existingDecimals = new Map();

  for (const asset of tokenAssets) {
    for (const vault of vaults) {
      const existing = getExistingCoin(vault, asset);
      if (Number.isFinite(existing?.decimals)) {
        existingDecimals.set(asset, Number(existing.decimals));
        break;
      }
    }

    const contractAddress = getEthTokenContractAddress(asset);
    if (!contractAddress) continue;

    requests.push({
      jsonrpc: '2.0',
      id: `decimals:${asset}`,
      method: 'eth_call',
      params: [
        buildEthCall(contractAddress, ERC20_INTERFACE.encodeFunctionData('decimals')),
        'latest'
      ]
    });
  }

  for (const vault of vaults) {
    const ethAddress = getVaultEthAddress(vault);
    if (!ethAddress) continue;

    requests.push({
      jsonrpc: '2.0',
      id: `native:${vault.pub_key}`,
      method: 'eth_getBalance',
      params: [ethAddress, 'latest']
    });

    const routerAddress = getVaultEthRouter(vault, inboundAddresses);
    for (const asset of tokenAssets) {
      const contractAddress = getEthTokenContractAddress(asset);
      if (!contractAddress) continue;

      const data = routerAddress
        ? ROUTER_INTERFACE.encodeFunctionData('vaultAllowance', [ethAddress, contractAddress])
        : ERC20_INTERFACE.encodeFunctionData('balanceOf', [ethAddress]);

      requests.push({
        jsonrpc: '2.0',
        id: `token:${vault.pub_key}:${asset}`,
        method: 'eth_call',
        params: [
          buildEthCall(routerAddress || contractAddress, data),
          'latest'
        ]
      });
    }
  }

  if (requests.length === 0) return vaults;

  const results = await postJsonRpcBatch(requests);
  const decimalsByAsset = new Map(existingDecimals);

  for (const asset of tokenAssets) {
    const result = results.get(`decimals:${asset}`);
    if (result?.result && !result.error) {
      const decimals = Number(decodeFunctionResult(ERC20_INTERFACE, 'decimals', result.result));
      if (Number.isFinite(decimals)) decimalsByAsset.set(asset, decimals);
    }
    if (!decimalsByAsset.has(asset)) decimalsByAsset.set(asset, DEFAULT_TOKEN_DECIMALS);
  }

  for (const vault of vaults) {
    const nativeResult = results.get(`native:${vault.pub_key}`);
    if (nativeResult?.result && !nativeResult.error) {
      addOrUpdateCoin(vault.coins, ETH_NATIVE_ASSET, toThorchainBaseAmount(BigInt(nativeResult.result), 18), {
        balance_source: 'eth_chain',
        thornode_amount: getExistingCoin(vault, ETH_NATIVE_ASSET)?.amount || null
      });
    }

    for (const asset of tokenAssets) {
      const tokenResult = results.get(`token:${vault.pub_key}:${asset}`);
      if (!tokenResult?.result || tokenResult.error) continue;

      const rawBalance = decodeFunctionResult(
        getVaultEthRouter(vault, inboundAddresses) ? ROUTER_INTERFACE : ERC20_INTERFACE,
        getVaultEthRouter(vault, inboundAddresses) ? 'vaultAllowance' : 'balanceOf',
        tokenResult.result
      );
      if (rawBalance == null) continue;

      const existing = getExistingCoin(vault, asset);
      addOrUpdateCoin(vault.coins, asset, toThorchainBaseAmount(rawBalance, decimalsByAsset.get(asset)), {
        balance_source: 'eth_chain',
        decimals: decimalsByAsset.get(asset),
        thornode_amount: existing?.amount || null
      });
    }
  }

  return vaults;
}
