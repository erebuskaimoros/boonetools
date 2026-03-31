const THOR_RUNE_ASSET = {
  chain: 'THOR',
  symbol: 'RUNE',
  ticker: 'RUNE'
};

const ACCOUNT_METHODS = ['request_accounts', 'get_accounts'];
const DEPOSIT_METHODS = ['deposit', 'deposit_transaction'];
const THOR_PROVIDER_PATHS = [
  ['xfi', 'thorchain'],
  ['thorchain'],
  ['vultisig', 'thorchain']
];

let activeThorProvider = null;

function normalizeWalletError(error, fallbackMessage) {
  if (!error) return new Error(fallbackMessage);
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error(error.message || fallbackMessage);
}

function getErrorMessage(error) {
  return (error?.message || String(error || '')).toLowerCase();
}

function isMethodUnsupportedError(error) {
  const message = getErrorMessage(error);
  return (
    message.includes('method not found') ||
    message.includes('unknown method') ||
    message.includes('unsupported method') ||
    message.includes('is not supported') ||
    message.includes('invalid method')
  );
}

function isUserRejectedError(error) {
  const message = getErrorMessage(error);
  return (
    message.includes('user rejected') ||
    message.includes('rejected by user') ||
    message.includes('user denied') ||
    message.includes('request denied') ||
    message.includes('canceled') ||
    message.includes('cancelled')
  );
}

function extractTxHash(result) {
  if (!result) return '';

  if (typeof result === 'object' && result.result !== undefined) {
    return extractTxHash(result.result);
  }

  if (typeof result === 'string') return result;

  return (
    result.hash ||
    result.txHash ||
    result.tx_hash ||
    result.transactionHash ||
    result.txHashHex ||
    result.txid ||
    ''
  );
}

function normalizeAccounts(result) {
  if (!result) return [];

  if (typeof result === 'object' && result.result !== undefined) {
    return normalizeAccounts(result.result);
  }

  if (Array.isArray(result)) {
    return result
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.address === 'string') return item.address;
        return '';
      })
      .filter(Boolean);
  }

  if (Array.isArray(result.accounts)) {
    return result.accounts
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.address === 'string') return item.address;
        return '';
      })
      .filter(Boolean);
  }

  if (Array.isArray(result.addresses)) {
    return result.addresses.filter((item) => typeof item === 'string');
  }

  if (typeof result.address === 'string') {
    return [result.address];
  }

  if (typeof result.account === 'string') {
    return [result.account];
  }

  if (result.account && typeof result.account.address === 'string') {
    return [result.account.address];
  }

  return [];
}

async function providerRequest(provider, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(normalizeWalletError(error, 'Wallet request failed'));
        return;
      }
      if (value && typeof value === 'object' && value.error) {
        reject(normalizeWalletError(value.error, 'Wallet request failed'));
        return;
      }

      resolve(value);
    };

    try {
      const maybePromise = provider.request(payload, (...args) => {
        if (args.length <= 1) {
          finish(null, args[0]);
          return;
        }

        finish(args[0], args[1]);
      });

      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((value) => finish(null, value)).catch((error) => finish(error));
      } else if (maybePromise !== undefined) {
        Promise.resolve().then(() => finish(null, maybePromise));
      }
    } catch (error) {
      finish(error);
    }
  });
}

function getProvidersFromWindow() {
  if (typeof window === 'undefined') {
    return [];
  }

  const providers = [];

  for (const path of THOR_PROVIDER_PATHS) {
    let candidate = window;

    for (const key of path) {
      candidate = candidate?.[key];
      if (!candidate) {
        break;
      }
    }

    if (candidate && typeof candidate.request === 'function' && !providers.includes(candidate)) {
      providers.push(candidate);
    }
  }

  return providers;
}

function getProviderCandidates() {
  const availableProviders = getProvidersFromWindow();
  if (!activeThorProvider) {
    return availableProviders;
  }

  if (!availableProviders.includes(activeThorProvider)) {
    activeThorProvider = null;
    return availableProviders;
  }

  return [activeThorProvider, ...availableProviders.filter((provider) => provider !== activeThorProvider)];
}

async function requestWithMethodFallback(provider, methods, params = []) {
  let lastError = null;

  for (let index = 0; index < methods.length; index += 1) {
    const method = methods[index];

    try {
      return await providerRequest(provider, {
        method,
        params
      });
    } catch (error) {
      lastError = normalizeWalletError(error, 'Wallet request failed');

      const canTryNextMethod =
        index < methods.length - 1 &&
        isMethodUnsupportedError(lastError) &&
        !isUserRejectedError(lastError);

      if (!canTryNextMethod) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Wallet request failed');
}

export function getThorProvider() {
  const providers = getProviderCandidates();
  return providers[0] || null;
}

export function getThorProviders() {
  return getProviderCandidates();
}

export function getThorProviderCount() {
  return getProviderCandidates().length;
}

export function clearActiveThorProvider() {
  activeThorProvider = null;
}

export function hasThorProvider() {
  return getProviderCandidates().length > 0;
}

export async function requestAccounts() {
  const providers = getProviderCandidates();
  if (providers.length === 0) {
    throw new Error('THOR wallet provider not found');
  }

  let lastError = null;

  for (const provider of providers) {
    try {
      const result = await requestWithMethodFallback(provider, ACCOUNT_METHODS, []);
      const accounts = normalizeAccounts(result);

      if (accounts.length === 0) {
        throw new Error('No THOR wallet accounts returned');
      }

      activeThorProvider = provider;
      return accounts;
    } catch (error) {
      lastError = normalizeWalletError(error, 'Wallet account request failed');

      if (isUserRejectedError(lastError)) {
        break;
      }
    }
  }

  throw lastError || new Error('No THOR wallet accounts returned');
}

export async function depositThorTx(params) {
  const providers = getProviderCandidates();
  if (providers.length === 0) {
    throw new Error('THOR wallet provider not found');
  }

  const amountBase = Number(params.amountBase);
  if (!Number.isFinite(amountBase) || amountBase < 0) {
    throw new Error('Invalid transaction amount');
  }

  if (!params.from || !params.recipient || !params.memo) {
    throw new Error('Missing deposit transaction fields');
  }

  const txParams = {
    asset: THOR_RUNE_ASSET,
    from: params.from,
    recipient: params.recipient,
    amount: {
      amount: String(Math.trunc(amountBase)),
      decimals: 8
    },
    memo: params.memo
  };

  let lastError = null;

  for (const provider of providers) {
    try {
      const result = await requestWithMethodFallback(provider, DEPOSIT_METHODS, [txParams]);
      activeThorProvider = provider;

      return {
        result,
        txHash: extractTxHash(result)
      };
    } catch (error) {
      lastError = normalizeWalletError(error, 'Deposit transaction failed');

      if (isUserRejectedError(lastError)) {
        break;
      }
    }
  }

  throw lastError || new Error('Deposit transaction failed');
}
