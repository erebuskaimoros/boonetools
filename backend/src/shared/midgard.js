import { config } from '../lib/config.js';
import { ProviderRequestError, requestFromProviders } from '../lib/provider-client.js';

const MIDGARD_PRIMARY = config.midgardUrl.replace(/\/$/, '');
const MIDGARD_FALLBACK = config.midgardFallbackUrl.replace(/\/$/, '');
const MIDGARD_REQUEST_TIMEOUT_MS = 10000;

const MIDGARD_BASES = Array.from(
  new Set([MIDGARD_PRIMARY, MIDGARD_FALLBACK].filter(Boolean))
);

function getPathSearchParams(path) {
  try {
    return new URL(path, MIDGARD_PRIMARY).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function shouldRetryMidgardResponse(path, data) {
  const params = getPathSearchParams(path);

  if (path.startsWith('/history/') && params.has('interval')) {
    return Array.isArray(data?.intervals) && data.intervals.length === 0 && data?.meta;
  }

  const requestedLimit = Number(params.get('limit'));
  if (
    path.startsWith('/actions') &&
    params.has('limit') &&
    Number.isFinite(requestedLimit) &&
    requestedLimit > 0 &&
    requestedLimit < 50 &&
    Array.isArray(data?.actions) &&
    data.actions.length > requestedLimit
  ) {
    return true;
  }

  return false;
}

function createMidgardError(message, details = {}) {
  return new ProviderRequestError(message, details);
}

export function isMidgardRateLimitError(error) {
  return Boolean(
    error?.status === 429 ||
    /HTTP 429|Too Many Requests|daily request limit|rate.?limit|rune pouch is empty/i.test(String(error?.message || '')) ||
    /daily request limit|rate.?limit|rune pouch is empty/i.test(String(error?.body || ''))
  );
}

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
    headers: { Accept: 'application/json' },
    validateResponse: (payload) => (
      typeof validateResponse === 'function' && validateResponse(path, payload)
        ? createMidgardError(`Midgard returned an unusable response for ${path}`)
        : null
    ),
    shouldStop: isMidgardRateLimitError,
    errorMessage: ({ status, statusText }) => (
      `Midgard error: ${status} ${statusText} for ${path}`
    )
  });
}

export async function fetchMidgardBond(bondAddress) {
  const payload = await fetchMidgard(`/bonds/${bondAddress}`, {
    validateResponse: (_path, data) => !Array.isArray(data?.nodes)
  });

  return payload;
}

export async function fetchMidgardActions(params = {}) {
  const query = new URLSearchParams(params).toString();
  const path = query ? `/actions?${query}` : '/actions';

  return fetchMidgard(path, {
    validateResponse: (candidatePath, data) => (
      shouldRetryMidgardResponse(candidatePath, data) || !Array.isArray(data?.actions)
    )
  });
}

export async function fetchMidgardChurns() {
  const payload = await fetchMidgard('/churns', {
    validateResponse: (_path, data) => !Array.isArray(data)
  });

  return payload;
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
