import { derived, get, writable } from 'svelte/store';

// ============================================
// UI State Stores
// ============================================

/** Currently selected trading pair: { source_asset, target_asset, displayName } */
export const selectedPair = writable(null);

/** Active tab: 'overview' | 'orderbook' | 'quote' */
export const activeTab = writable('overview');

/** Orderbook depth filter: 'all' | 'buy' | 'sell' */
export const bookFilter = writable('all');

/** Orders table sort field */
export const ordersSortBy = writable('ratio');

/** Orders table sort direction */
export const ordersSortOrder = writable('asc');

/** Orders table pagination offset */
export const ordersPage = writable(0);

// ============================================
// Wallet State Stores
// ============================================

const WALLET_STORAGE_KEY = 'boonetools-wallet-state';

function normalizeChain(chain) {
  const value = String(chain ?? '').trim();
  return value ? value.toUpperCase() : '';
}

function normalizeProvider(provider) {
  const value = String(provider ?? '').trim();
  return value ? value.toUpperCase() : '';
}

export function normalizeWalletAccount(account) {
  if (!account?.address || !account?.network || !account?.provider) {
    return null;
  }

  return {
    address: String(account.address).trim(),
    network: normalizeChain(account.network),
    provider: normalizeProvider(account.provider)
  };
}

function accountKey(account) {
  const normalized = normalizeWalletAccount(account);
  return normalized ? `${normalized.provider}:${normalized.network}:${normalized.address}` : '';
}

export function sameAccount(left, right) {
  return !!accountKey(left) && accountKey(left) === accountKey(right);
}

function uniqueAccounts(accounts) {
  const seen = new Set();
  return (Array.isArray(accounts) ? accounts : [])
    .map(normalizeWalletAccount)
    .filter(Boolean)
    .filter((account) => {
      const key = accountKey(account);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeConnectedWalletList(wallets) {
  return Array.from(new Set((Array.isArray(wallets) ? wallets : [])
    .map(normalizeProvider)
    .filter(Boolean)));
}

function normalizeAssignment(assignment) {
  if (!assignment?.address || !assignment?.provider) return null;

  return {
    address: String(assignment.address).trim(),
    provider: normalizeProvider(assignment.provider),
    source: assignment?.source === 'manual' ? 'manual' : 'auto'
  };
}

function normalizeChainAssignments(assignments) {
  const nextAssignments = {};

  for (const [chain, assignment] of Object.entries(assignments || {})) {
    const normalizedChain = normalizeChain(chain);
    const normalizedAssignment = normalizeAssignment(assignment);
    if (normalizedChain && normalizedAssignment) {
      nextAssignments[normalizedChain] = normalizedAssignment;
    }
  }

  return nextAssignments;
}

export function createAssignmentFromAccount(account, source = 'auto') {
  const normalized = normalizeWalletAccount(account);
  if (!normalized) return null;

  return {
    address: normalized.address,
    provider: normalized.provider,
    source: source === 'manual' ? 'manual' : 'auto'
  };
}

export function getAccountsForChain(accounts, chain) {
  const normalizedChain = normalizeChain(chain);
  return uniqueAccounts(accounts).filter((account) => account.network === normalizedChain);
}

function findMatchingAccount(accounts, chain, assignment) {
  const normalizedAssignment = normalizeAssignment(assignment);
  if (!normalizedAssignment) return null;

  return getAccountsForChain(accounts, chain).find(
    (account) =>
      account.provider === normalizedAssignment.provider &&
      account.address === normalizedAssignment.address
  ) || null;
}

function reconcileAssignment(accounts, chain, assignment) {
  const normalizedChain = normalizeChain(chain);
  if (!normalizedChain) return null;

  const preserved = findMatchingAccount(accounts, normalizedChain, assignment);
  if (preserved) {
    return createAssignmentFromAccount(preserved, assignment?.source);
  }

  const candidates = getAccountsForChain(accounts, normalizedChain);
  return candidates.length === 1 ? createAssignmentFromAccount(candidates[0], 'auto') : null;
}

export function reconcileChainAssignments(accounts, assignments) {
  const chains = new Set([
    ...Object.keys(assignments || {}).map(normalizeChain),
    ...uniqueAccounts(accounts).map((account) => account.network)
  ]);

  const nextAssignments = {};
  for (const chain of chains) {
    const nextAssignment = reconcileAssignment(accounts, chain, assignments?.[chain]);
    if (nextAssignment) {
      nextAssignments[chain] = nextAssignment;
    }
  }

  return nextAssignments;
}

export function reconcileTradeOwner(accounts, tradeOwner) {
  return reconcileAssignment(accounts, 'THOR', tradeOwner);
}

function fillEmptyAssignments(accounts, assignments, preferredAccounts = []) {
  const nextAssignments = { ...(assignments || {}) };
  const accountList = uniqueAccounts(accounts);

  for (const preferred of uniqueAccounts(preferredAccounts)) {
    const chain = preferred.network;
    if (nextAssignments[chain]) continue;

    const candidates = accountList.filter((account) => account.network === chain);
    if (candidates.length === 1) {
      nextAssignments[chain] = createAssignmentFromAccount(preferred, 'auto');
    }
  }

  return nextAssignments;
}

function fillTradeOwner(accounts, tradeOwner, preferredAccounts = []) {
  if (tradeOwner) return tradeOwner;

  const thorAccounts = getAccountsForChain(accounts, 'THOR');
  if (thorAccounts.length === 1) {
    return createAssignmentFromAccount(thorAccounts[0], 'auto');
  }

  const preferredThor = uniqueAccounts(preferredAccounts).find((account) => account.network === 'THOR');
  if (preferredThor && thorAccounts.length === 1) {
    return createAssignmentFromAccount(preferredThor, 'auto');
  }

  return null;
}

function normalizeSelectedAccount(accounts, selected) {
  const normalizedSelected = normalizeWalletAccount(selected);
  if (!normalizedSelected) return null;

  return uniqueAccounts(accounts).find((account) => sameAccount(account, normalizedSelected)) || null;
}

function loadWalletState() {
  if (typeof localStorage === 'undefined') {
    return {
      accounts: [],
      selectedAccount: null,
      connectedWallets: [],
      chainAssignments: {},
      tradeOwner: null
    };
  }

  try {
    const stored = localStorage.getItem(WALLET_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const accounts = uniqueAccounts(parsed?.accounts);
      const selectedAccount = normalizeSelectedAccount(accounts, parsed?.selectedAccount ?? parsed?.selected);
      const connectedWallets = normalizeConnectedWalletList(parsed?.connectedWallets);
      const chainAssignments = reconcileChainAssignments(accounts, normalizeChainAssignments(parsed?.chainAssignments));
      const tradeOwner = reconcileTradeOwner(accounts, normalizeAssignment(parsed?.tradeOwner));

      return {
        accounts,
        selectedAccount,
        connectedWallets,
        chainAssignments,
        tradeOwner
      };
    }
  } catch (_) {
    // ignore parse/storage errors
  }

  return {
    accounts: [],
    selectedAccount: null,
    connectedWallets: [],
    chainAssignments: {},
    tradeOwner: null
  };
}

const initialWallet = loadWalletState();

/** All connected wallet accounts: [{ address, network, provider }] */
export const walletAccounts = writable(initialWallet.accounts);

/** UI-focused wallet account */
export const selectedAccount = writable(initialWallet.selectedAccount);

/** Set of connected wallet provider names */
export const connectedWallets = writable(initialWallet.connectedWallets);

/** Explicit source wallet per chain: { [chain]: { address, provider, source } } */
export const chainAssignments = writable(initialWallet.chainAssignments);

/** Explicit THOR trade-account owner: { address, provider, source } */
export const tradeOwner = writable(initialWallet.tradeOwner);

function persistWalletState() {
  if (typeof localStorage === 'undefined') return;

  const accounts = get(walletAccounts);
  const selected = get(selectedAccount);
  const wallets = get(connectedWallets);
  const assignments = get(chainAssignments);
  const owner = get(tradeOwner);

  try {
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify({
      accounts,
      chainAssignments: assignments,
      connectedWallets: wallets,
      selectedAccount: selected,
      tradeOwner: owner
    }));
  } catch (_) {
    // ignore storage errors
  }
}

walletAccounts.subscribe(persistWalletState);
selectedAccount.subscribe(persistWalletState);
connectedWallets.subscribe(persistWalletState);
chainAssignments.subscribe(persistWalletState);
tradeOwner.subscribe(persistWalletState);

/** Whether any wallet is connected */
export const isWalletConnected = derived(walletAccounts, ($accounts) => $accounts.length > 0);

/** Get the address for a specific chain from connected accounts */
export function getAddressForChain(accounts, chain) {
  const account = getAccountsForChain(accounts, chain)[0];
  return account?.address || null;
}

export function getAssignedAccount(accounts, assignments, chain) {
  return findMatchingAccount(accounts, chain, assignments?.[normalizeChain(chain)]) || null;
}

export function getTradeOwnerAccount(accounts, ownerAssignment) {
  return findMatchingAccount(accounts, 'THOR', ownerAssignment) || null;
}

export function setSelectedAccount(account) {
  selectedAccount.set(normalizeWalletAccount(account));
}

export function setChainAssignment(chain, account, source = 'manual') {
  const normalizedChain = normalizeChain(chain);
  const assignment = createAssignmentFromAccount(account, source);

  chainAssignments.update((current) => {
    const nextAssignments = { ...(current || {}) };
    if (normalizedChain && assignment) {
      nextAssignments[normalizedChain] = assignment;
    } else {
      delete nextAssignments[normalizedChain];
    }
    return nextAssignments;
  });
}

export function clearChainAssignment(chain) {
  const normalizedChain = normalizeChain(chain);
  chainAssignments.update((current) => {
    const nextAssignments = { ...(current || {}) };
    delete nextAssignments[normalizedChain];
    return nextAssignments;
  });
}

export function setTradeOwnerAccount(account, source = 'manual') {
  tradeOwner.set(createAssignmentFromAccount(account, source));
}

export function clearTradeOwner() {
  tradeOwner.set(null);
}

export function connectWalletAccounts(provider, nextAccounts) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedAccounts = uniqueAccounts(nextAccounts).filter((account) => account.provider === normalizedProvider);
  const existingAccounts = get(walletAccounts);
  const mergedAccounts = uniqueAccounts([
    ...existingAccounts.filter((account) => account.provider !== normalizedProvider),
    ...normalizedAccounts
  ]);

  const currentAssignments = get(chainAssignments);
  const currentTradeOwner = get(tradeOwner);
  const currentSelected = get(selectedAccount);

  let nextAssignments = reconcileChainAssignments(mergedAccounts, currentAssignments);
  nextAssignments = fillEmptyAssignments(mergedAccounts, nextAssignments, normalizedAccounts);
  let nextTradeOwner = reconcileTradeOwner(mergedAccounts, currentTradeOwner);
  nextTradeOwner = fillTradeOwner(mergedAccounts, nextTradeOwner, normalizedAccounts);

  const nextSelectedAccount = normalizeSelectedAccount(mergedAccounts, currentSelected)
    || normalizeSelectedAccount(mergedAccounts, normalizedAccounts[0])
    || null;

  walletAccounts.set(mergedAccounts);
  connectedWallets.set(normalizeConnectedWalletList([...get(connectedWallets), normalizedProvider]));
  chainAssignments.set(nextAssignments);
  tradeOwner.set(nextTradeOwner);
  selectedAccount.set(nextSelectedAccount);
}

export function disconnectWalletAccounts(provider) {
  const normalizedProvider = normalizeProvider(provider);
  const remainingAccounts = uniqueAccounts(get(walletAccounts).filter((account) => account.provider !== normalizedProvider));
  const nextAssignments = reconcileChainAssignments(remainingAccounts, get(chainAssignments));
  const nextTradeOwner = reconcileTradeOwner(remainingAccounts, get(tradeOwner));
  const nextSelectedAccount = normalizeSelectedAccount(remainingAccounts, get(selectedAccount))
    || remainingAccounts[0]
    || null;

  walletAccounts.set(remainingAccounts);
  connectedWallets.set(normalizeConnectedWalletList(get(connectedWallets).filter((wallet) => wallet !== normalizedProvider)));
  chainAssignments.set(nextAssignments);
  tradeOwner.set(nextTradeOwner);
  selectedAccount.set(nextSelectedAccount);
}
