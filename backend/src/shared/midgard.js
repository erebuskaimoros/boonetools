import { config } from '../lib/config.js';
import { ProviderRequestError, requestFromProviders } from '../lib/provider-client.js';
import { providerLifecycleHooks } from './provider-cooldown.js';
import { isMidgardPayloadInvalid as shouldRetryMidgardResponse } from '../../../shared/midgard-policy.js';
import { isProviderRateLimitError } from '../../../shared/provider-policy.js';

const MIDGARD_PRIMARY = (config.midgardUrls[0] || config.midgardUrl).replace(/\/$/, '');
const MIDGARD_FALLBACK = (config.midgardUrls[1] || config.midgardFallbackUrl).replace(/\/$/, '');
const MIDGARD_REQUEST_TIMEOUT_MS = 10000;

const MIDGARD_BASES = Array.from(
  new Set(config.midgardUrls.map((base) => base.replace(/\/$/, '')).filter(Boolean))
);

function createMidgardError(message, details = {}) {
  return new ProviderRequestError(message, details);
}

export const isMidgardRateLimitError = isProviderRateLimitError;

export async function fetchMidgard(path, options = {}) {
  const {
    bases = MIDGARD_BASES,
    validateResponse = shouldRetryMidgardResponse
  } = options;
  const baseList = Array.isArray(bases) && bases.length ? bases : MIDGARD_BASES;
  return requestFromProviders({
    bases: baseList,
    path,
    timeoutMs: options.timeoutMs || MIDGARD_REQUEST_TIMEOUT_MS,
    ...(options.midgardBudget !== undefined ? { midgardBudget: options.midgardBudget } : {}),
    ...(options.midgardBudgetClass ? { midgardBudgetClass: options.midgardBudgetClass } : {}),
    ...(options.signal || options.request ? { request: { ...options.request,
      ...(options.signal ? { signal: options.signal } : {}) } } : {}),
    headers: {
      Accept: 'application/json',
      'x-client-id': config.providerClientId
    },
    ...providerLifecycleHooks({
      client: options.cooldownClient,
      enabled: options.sharedCooldown,
      // Slow actions queries should not block health/history; gateway limits stay shared.
      scope: /^\/actions\/?(?:[?#]|$)/.test(path) ? 'actions' : undefined
    }),
    validateResponse: (payload) => (
      typeof validateResponse === 'function' && validateResponse(path, payload)
        ? createMidgardError(`Midgard returned an unusable response for ${path}`)
        : null
    ),
    shouldStop: (error) => !error?.skipProvider && isMidgardRateLimitError(error),
    errorMessage: ({ status, statusText }) => (
      `Midgard error: ${status} ${statusText} for ${path}`
    )
  });
}

export async function fetchMidgardBond(bondAddress, options = {}) {
  const payload = await fetchMidgard(`/bonds/${bondAddress}`, {
    ...options,
    validateResponse: (_path, data) => !Array.isArray(data?.nodes)
  });

  return payload;
}

export async function fetchMidgardActions(params = {}, options = {}) {
  const query = new URLSearchParams(params).toString();
  const path = query ? `/actions?${query}` : '/actions';

  return fetchMidgard(path, {
    ...options,
    validateResponse: (candidatePath, data) => (
      shouldRetryMidgardResponse(candidatePath, data) || !Array.isArray(data?.actions)
    )
  });
}

export async function fetchMidgardChurns(options = {}) {
  const payload = await fetchMidgard('/churns', {
    ...options,
    validateResponse: (_path, data) => !Array.isArray(data)
  });

  return payload;
}

export async function fetchMidgardNetwork(options = {}) {
  return fetchMidgard('/network', {
    ...options,
    validateResponse: (_path, data) => !data || typeof data !== 'object' || Array.isArray(data)
  });
}

export async function fetchMidgardSwapHistory(params = {}) {
  const query = new URLSearchParams(params).toString();
  const path = query ? `/history/swaps?${query}` : '/history/swaps';

  return fetchMidgard(path, {
    validateResponse: (candidatePath, data) => (
      shouldRetryMidgardResponse(candidatePath, data) || !Array.isArray(data?.intervals)
    )
  });
}

export {
  MIDGARD_BASES,
  MIDGARD_FALLBACK,
  MIDGARD_PRIMARY
};
