import { config } from '../lib/config.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { providerLifecycleHooks } from './provider-cooldown.js';

const RPC_TIMEOUT_MS = 15000;

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

async function fetchFromBases(bases, path, params = {}, options = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  const requestPath = `${normalizePath(path)}${query ? `?${query}` : ''}`;
  return requestFromProviders({
    bases: bases.filter(Boolean).map(trimBaseUrl),
    path: requestPath,
    timeoutMs: options.timeoutMs || RPC_TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      'x-client-id': config.providerClientId
    },
    ...providerLifecycleHooks({
      client: options.cooldownClient,
      enabled: options.sharedCooldown,
      scope: options.cooldownScope
    })
  });
}

export async function fetchThorchainRpc(path, params = {}, options = {}) {
  return fetchFromBases(options.rpcUrls || config.rpcRestUrls, path, params, {
    ...options,
    timeoutMs: options.timeoutMs || RPC_TIMEOUT_MS
  });
}
