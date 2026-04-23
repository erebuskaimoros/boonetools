import { config } from '../lib/config.js';

const MIDGARD_PRIMARY = config.midgardUrl.replace(/\/$/, '');
const MIDGARD_FALLBACK = config.midgardFallbackUrl.replace(/\/$/, '');
const MIDGARD_REQUEST_TIMEOUT_MS = 10000;

const MIDGARD_BASES = Array.from(
  new Set([MIDGARD_PRIMARY, MIDGARD_FALLBACK].filter(Boolean))
);

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
}

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
    Number.isFinite(requestedLimit) &&
    requestedLimit >= 0 &&
    requestedLimit < 50 &&
    Array.isArray(data?.actions) &&
    data.actions.length > requestedLimit
  ) {
    return true;
  }

  return false;
}

async function parseJsonResponse(response, url) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

function createMidgardError(message, details = {}) {
  const error = new Error(message);
  error.status = details.status || 0;
  error.url = details.url || '';
  error.body = details.body || '';
  return error;
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
  let lastError = null;

  for (const base of baseList) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MIDGARD_REQUEST_TIMEOUT_MS);
    const url = `${base}${path}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw createMidgardError(`Midgard error: ${response.status} ${response.statusText} for ${path}`, {
          status: response.status,
          url,
          body: body.slice(0, 240)
        });
      }

      if (isChallengeResponse(response)) {
        throw new Error(`Midgard challenge response for ${path}`);
      }

      const payload = await parseJsonResponse(response, url);
      const shouldRetry = typeof validateResponse === 'function' && validateResponse(path, payload);
      if (shouldRetry) {
        throw new Error(`Midgard returned an unusable response for ${path}`);
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (isMidgardRateLimitError(error)) {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error(`Unable to fetch Midgard path ${path}`);
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
