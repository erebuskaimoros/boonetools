/**
 * @tcswap SDK wrapper for wallet connection, tx signing, and memoless flows.
 * Adapted from swap.thorchain's lib/wallets.ts
 */

import { AssetValue, Chain, USwap, WalletOption, FeeOption, ProviderName, getEIP6963Wallets } from '@tcswap/core';
import { EVMPlugin } from '@tcswap/plugins/evm';
import { ThorchainPlugin } from '@tcswap/plugins/thorchain';
import { SolanaPlugin } from '@tcswap/plugins/solana';
import { ctrlWallet } from '@tcswap/wallets/ctrl';
import { evmWallet } from '@tcswap/wallets/evm-extensions';
import { keplrWallet } from '@tcswap/wallets/keplr';
import { keystoreWallet } from '@tcswap/wallets/keystore';
import { ledgerWallet } from '@tcswap/wallets/ledger';
import { okxWallet } from '@tcswap/wallets/okx';
import { phantomWallet } from '@tcswap/wallets/phantom';
import { vultisigWallet } from '@tcswap/wallets/vultisig';
import { USwapApi } from '@tcswap/helpers/api';
import {
  connectWalletAccounts,
  disconnectWalletAccounts,
  selectedAccount
} from './store.js';

// ============================================
// USwap Singleton
// ============================================

const defaultPlugins = {
  ...EVMPlugin,
  ...ThorchainPlugin,
  ...SolanaPlugin
};

const defaultWallets = {
  ...ctrlWallet,
  ...evmWallet,
  ...keplrWallet,
  ...keystoreWallet,
  ...ledgerWallet,
  ...okxWallet,
  ...phantomWallet,
  ...vultisigWallet
};

let instance = null;
const activeProviderOverrides = [];

function getSelectedProvider() {
  if (activeProviderOverrides.length > 0) {
    return activeProviderOverrides[activeProviderOverrides.length - 1];
  }

  let selected;
  selectedAccount.subscribe(v => selected = v)();
  return selected?.provider;
}

export async function withActiveProvider(provider, callback) {
  if (!provider) {
    throw new Error('Wallet provider is required');
  }

  activeProviderOverrides.push(provider);
  try {
    return await callback();
  } finally {
    activeProviderOverrides.pop();
  }
}

export function getUSwap() {
  if (instance) return instance;

  instance = USwap({
    plugins: defaultPlugins,
    wallets: defaultWallets,
    getActiveWallet: getSelectedProvider
  });

  return instance;
}

function isTradeAssetIdentifier(asset) {
  return String(asset ?? '').includes('~');
}

function toSdkAsset(asset) {
  const value = String(asset ?? '').trim();
  if (!value) return '';
  if (value.startsWith('THOR.')) return value;
  return isTradeAssetIdentifier(value) ? `THOR.${value}` : value;
}

function buildThorchainRoute({
  quote,
  sellAsset,
  buyAsset,
  sellAmount,
  destinationAddress,
  sourceAddress,
  routeProvider = ProviderName.THORCHAIN
}) {
  if (!quote?.memo) throw new Error('Quote memo missing');
  if (!sellAsset || !buyAsset || sellAmount == null || !destinationAddress) {
    throw new Error('Incomplete THORChain route');
  }

  const expectedBuyAmount = String(quote.expected_amount_out ?? quote.expectedBuyAmount ?? '0');

  return {
    buyAsset: toSdkAsset(buyAsset),
    destinationAddress,
    expectedBuyAmount,
    expectedBuyAmountMaxSlippage: expectedBuyAmount,
    expiration: quote.expiry ? String(quote.expiry) : undefined,
    fees: [],
    inboundAddress: quote.inbound_address ?? quote.inboundAddress ?? undefined,
    memo: quote.memo,
    providers: [routeProvider],
    refundAddress: sourceAddress || undefined,
    sellAmount: String(sellAmount),
    sellAsset: toSdkAsset(sellAsset),
    sourceAddress: sourceAddress || undefined,
    targetAddress: quote.router || quote.targetAddress || undefined,
  };
}

// ============================================
// Wallet Connection
// ============================================

/** Supported chains per wallet provider */
export const supportedChains = {
  [WalletOption.CTRL]: ctrlWallet.connectCtrl?.supportedChains || [],
  [WalletOption.METAMASK]: evmWallet.connectEVMWallet?.supportedChains || [],
  [WalletOption.KEPLR]: keplrWallet.connectKeplr?.supportedChains || [],
  [WalletOption.KEYSTORE]: keystoreWallet.connectKeystore?.supportedChains || [],
  [WalletOption.LEDGER]: ledgerWallet.connectLedger?.supportedChains || [],
  [WalletOption.OKX]: okxWallet.connectOkx?.supportedChains || [],
  [WalletOption.PHANTOM]: phantomWallet.connectPhantom?.supportedChains || [],
  [WalletOption.VULTISIG]: vultisigWallet.connectVultisig?.supportedChains || [],
};

/** Check if a wallet extension is available in the browser */
export function isWalletAvailable(option) {
  if (typeof window === 'undefined') return false;
  switch (option) {
    case WalletOption.CTRL: return !!(window.xfi || window.ethereum?.__XDEFI);
    case WalletOption.METAMASK: return !!(window.ethereum && !window.ethereum?.isBraveWallet);
    case WalletOption.KEPLR: return !!window.keplr;
    case WalletOption.PHANTOM: return !!window.phantom;
    case WalletOption.OKX: return !!window.okxwallet;
    case WalletOption.VULTISIG: return !!window.vultisig;
    case WalletOption.KEYSTORE: return true; // always available (local key)
    case WalletOption.LEDGER: return true; // always available (USB)
    default: return false;
  }
}

/**
 * Connect a wallet and return accounts
 * @param {string} option - WalletOption enum value
 * @param {string[]} chains - Chain enum values to connect
 * @param {Object} config - Optional config (phrase for keystore, derivationPath for ledger)
 * @returns {Promise<Array<{address: string, network: string, provider: string}>>}
 */
export async function connectWallet(option, chains, config) {
  const uSwap = getUSwap();

  const connectEach = async (connectFn) => {
    let successCount = 0;
    for (const chain of chains) {
      try {
        await connectFn([chain]);
        successCount++;
      } catch (error) {
        console.warn(`Failed to connect ${chain}:`, error);
      }
    }
    return successCount > 0;
  };

  let connected = false;
  switch (option) {
    case WalletOption.METAMASK: {
      const metamask = getEIP6963Wallets().providers.find(p => p.info.name === 'MetaMask');
      connected = await connectEach(c => uSwap.connectEVMWallet(c, WalletOption.METAMASK, metamask?.provider));
      break;
    }
    case WalletOption.PHANTOM:
      connected = await connectEach(c => uSwap.connectPhantom(c));
      break;
    case WalletOption.KEPLR:
      connected = await connectEach(c => uSwap.connectKeplr(c));
      break;
    case WalletOption.CTRL:
      connected = await connectEach(c => uSwap.connectCtrl(c));
      break;
    case WalletOption.OKX:
      connected = await connectEach(c => uSwap.connectOkx(c));
      break;
    case WalletOption.VULTISIG:
      connected = await connectEach(c => uSwap.connectVultisig(c));
      break;
    case WalletOption.KEYSTORE:
      connected = await uSwap.connectKeystore(chains, config?.phrase, config?.derivationPath);
      break;
    case WalletOption.LEDGER:
      connected = await connectEach(c => uSwap.connectLedger(c, config?.derivationPath));
      break;
    default:
      throw new Error(`Unsupported wallet: ${option}`);
  }

  if (!connected) return [];

  const accounts = chains
    .map(chain => {
      const address = uSwap.getAddress(chain);
      return address ? { address, network: chain, provider: option } : null;
    })
    .filter(Boolean);

  connectWalletAccounts(option, accounts);

  return accounts;
}

/** Disconnect a wallet provider */
export function disconnectWallet(option) {
  const uSwap = getUSwap();
  const chains = supportedChains[option] || [];
  chains.forEach(chain => {
    try { uSwap.disconnectChain(chain); } catch (e) { /* ignore */ }
  });

  disconnectWalletAccounts(option);
}

/**
 * Fetch balances for a connected chain wallet scoped to a specific provider.
 *
 * @param {string} provider - Wallet provider
 * @param {string} chain - Chain identifier
 * @param {boolean} [refresh=true] - Force a balance refresh
 * @returns {Promise<Array>} Chain balances
 */
export async function getProviderChainBalance(provider, chain, refresh = true) {
  const uSwap = getUSwap();
  const wallet = uSwap.getWallet(provider, chain);

  if (!wallet) {
    throw new Error(`No connected ${chain} wallet on ${provider}`);
  }

  const defaultBalance = [AssetValue.from({ chain })];
  wallet.balance = defaultBalance;

  if (!refresh || !('getBalance' in wallet)) {
    return wallet.balance || defaultBalance;
  }

  const balance = await wallet.getBalance(wallet.address, true);
  wallet.balance = balance;
  return balance;
}

// ============================================
// Transaction Broadcasting
// ============================================

/**
 * Broadcast a limit order swap via connected wallet
 * @param {Object} routeOrQuote - Adapted route input or raw THORNode quote context
 * @param {Object} options
 * @param {string} options.provider - Wallet provider used for signing
 * @returns {Promise<string>} Transaction hash
 */
export async function broadcastSwap(routeOrQuote, { provider } = {}) {
  const uSwap = getUSwap();
  const route = routeOrQuote?.quote
    ? buildThorchainRoute(routeOrQuote)
    : {
        ...routeOrQuote,
        buyAsset: toSdkAsset(routeOrQuote?.buyAsset),
        sellAsset: toSdkAsset(routeOrQuote?.sellAsset),
        providers: routeOrQuote?.providers?.length ? routeOrQuote.providers : [ProviderName.THORCHAIN]
      };

  return withActiveProvider(provider, () =>
    uSwap.swap({ route, pluginName: 'thorchain', feeOptionKey: FeeOption.Fast })
  );
}

/**
 * Broadcast a direct THORChain deposit transaction.
 * Used for modify/cancel memos that are not normal swap routes.
 *
 * @param {Object} params
 * @param {string} params.asset - Asset identifier
 * @param {string|number} [params.amount] - Amount in base units
 * @param {string} params.memo - THORChain memo
 * @param {string} [params.recipient] - Override deposit recipient
 * @param {Object} options
 * @param {string} options.provider - Wallet provider used for signing
 * @returns {Promise<string>} Transaction hash
 */
export async function broadcastDeposit({ asset, amount = '0', memo, recipient = '' }, { provider } = {}) {
  if (!asset || !memo) throw new Error('Asset and memo are required');

  const uSwap = getUSwap();
  const assetValue = await AssetValue.from({
    asset: toSdkAsset(asset),
    asyncTokenLookup: true,
    value: String(amount)
  });

  if (!assetValue) {
    throw new Error('Failed to build THORChain deposit asset');
  }

  return withActiveProvider(provider, () =>
    uSwap.thorchain.deposit({
      assetValue,
      feeOptionKey: FeeOption.Fast,
      memo,
      recipient
    })
  );
}

/**
 * Deposit an L1 asset into the connected THOR trade account owner.
 *
 * @param {Object} params
 * @param {string} params.asset - L1 asset identifier
 * @param {string|number} params.amount - Human-readable amount
 * @param {string} params.owner - THOR address that owns the trade account
 * @param {Object} options
 * @param {string} options.provider - Wallet provider used for signing
 * @returns {Promise<string>} Transaction hash
 */
export async function broadcastTradeAccountDeposit({ asset, amount, owner }, { provider } = {}) {
  if (!asset || !amount || !owner) {
    throw new Error('Asset, amount, and THOR owner are required');
  }

  const uSwap = getUSwap();
  const assetValue = await AssetValue.from({
    asset: toSdkAsset(asset),
    asyncTokenLookup: true,
    value: String(amount)
  });

  if (!assetValue) {
    throw new Error('Failed to build trade-account deposit asset');
  }

  return withActiveProvider(provider, () =>
    uSwap.thorchain.depositToPool({
      assetValue,
      feeOptionKey: FeeOption.Fast,
      memo: `TRADE+:${owner}`
    })
  );
}

/**
 * Withdraw a trade asset back to its L1 destination.
 *
 * @param {Object} params
 * @param {string} params.asset - Trade asset identifier
 * @param {string|number} params.amount - Human-readable amount
 * @param {string} params.destinationAddress - L1 destination address
 * @param {Object} options
 * @param {string} options.provider - Wallet provider used for signing
 * @returns {Promise<string>} Transaction hash
 */
export async function broadcastTradeAccountWithdrawal({ asset, amount, destinationAddress }, { provider } = {}) {
  if (!asset || !amount || !destinationAddress) {
    throw new Error('Asset, amount, and destination address are required');
  }

  const uSwap = getUSwap();
  const assetValue = await AssetValue.from({
    asset: toSdkAsset(asset),
    asyncTokenLookup: true,
    value: String(amount)
  });

  if (!assetValue) {
    throw new Error('Failed to build trade-account withdrawal asset');
  }

  return withActiveProvider(provider, () =>
    uSwap.thorchain.deposit({
      assetValue,
      feeOptionKey: FeeOption.Fast,
      memo: `TRADE-:${destinationAddress}`,
      recipient: ''
    })
  );
}

// ============================================
// Memoless Flow
// ============================================

/**
 * Get available memoless assets
 * @returns {Promise<Array>} Available memoless assets
 */
export async function getMemolessAssets() {
  const data = await USwapApi.getMemolessAssets();
  return (data.assets || []).filter(a => a.status === 'Available');
}

/**
 * Register a memoless transaction and get deposit channel
 * @param {string} asset - Asset identifier (e.g., "BTC.BTC")
 * @param {string} memo - The limit order memo
 * @param {string} amount - Requested amount in asset units
 * @returns {Promise<{qrCodeData: string, address: string, value: string, expiration: number}>}
 */
export async function createMemolessChannel(asset, memo, amount) {
  const registration = await USwapApi.registerMemoless({
    asset,
    memo,
    requested_in_asset_amount: amount
  }, { retry: { maxRetries: 0 } });

  const suggestedAmount = registration.suggested_in_asset_amount;
  if (!suggestedAmount) {
    throw new Error('Failed to calculate suggested amount');
  }

  const preflight = await USwapApi.preflightMemoless({
    asset,
    reference: registration.reference,
    amount: suggestedAmount
  });

  if (!preflight.data?.qr_code_data_url || !preflight.data?.inbound_address) {
    throw new Error('Failed to create deposit channel');
  }

  return {
    qrCodeData: preflight.data.qr_code_data_url,
    address: preflight.data.inbound_address,
    value: suggestedAmount,
    expiration: preflight.data.seconds_remaining
      ? Date.now() + preflight.data.seconds_remaining * 1000
      : null
  };
}

// Re-export for convenience
export { Chain, WalletOption, FeeOption };
