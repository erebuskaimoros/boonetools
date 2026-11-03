// Public configuration and saved chain hints only. Keep this module SDK-free so
// loading a page without a WalletConnect session does not load wallet libraries.
export const WALLET_STORAGE_KEY = 'boonetools-wallet-state';
export const WALLETCONNECT_PROVIDER = 'WALLETCONNECT';
export const walletConnectProjectId = String(import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID || '').trim();

export function walletConnectEnabled() {
  return /^[a-f0-9]{32}$/i.test(walletConnectProjectId);
}

export function readSavedWalletConnectChains(storage = undefined) {
  try {
    const savedStorage = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    const saved = JSON.parse(savedStorage?.getItem(WALLET_STORAGE_KEY) || '{}');
    const accounts = Array.isArray(saved.accounts) ? saved.accounts : [];
    const hints = Array.isArray(saved.walletConnectChains) ? saved.walletConnectChains : [];
    return [...new Set([
      ...hints,
      ...accounts.filter((account) => account?.provider === WALLETCONNECT_PROVIDER).map((account) => account.network)
    ].filter((chain) => typeof chain === 'string' && /^[a-z0-9]+$/i.test(chain)).map((chain) => chain.toUpperCase()))];
  } catch {
    return [];
  }
}

export function hasSavedWalletConnectSession() {
  return readSavedWalletConnectChains().length > 0;
}
