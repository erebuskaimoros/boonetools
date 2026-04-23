import { error, json, parseIntegerParam } from '../lib/http.js';
import { fetchMidgardSwapHistory, isMidgardRateLimitError } from '../shared/midgard.js';
import { getCachedResponse, setCachedResponse } from '../shared/response-cache.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_INTERVALS = new Set(['hour', 'day', 'week', 'month']);

function buildParams(url) {
  const interval = String(url.searchParams.get('interval') || 'hour').toLowerCase();
  if (!ALLOWED_INTERVALS.has(interval)) {
    throw new Error('Invalid interval parameter');
  }

  const params = {
    interval
  };

  const pool = String(url.searchParams.get('pool') || '').trim();
  if (pool) {
    params.pool = pool;
  }

  const from = parseIntegerParam(url.searchParams.get('from'), 0, { min: 0 });
  const to = parseIntegerParam(url.searchParams.get('to'), 0, { min: 0 });
  const count = parseIntegerParam(url.searchParams.get('count'), 0, { min: 0, max: 400 });

  if (from > 0 || to > 0) {
    if (from <= 0 || to <= 0 || from > to) {
      throw new Error('Invalid from/to parameters');
    }
    params.from = String(from);
    params.to = String(to);
  } else if (count > 0) {
    params.count = String(count);
  }

  return params;
}

function cacheKeyForParams(params) {
  const normalized = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    normalized.set(key, String(params[key]));
  }
  return `midgard:history:swaps:${normalized.toString()}`;
}

export async function handleRapidSwapsSwapHistory(_request, url) {
  let params;
  try {
    params = buildParams(url);
  } catch (buildError) {
    return error(buildError.message || 'Invalid swap history parameters', 400);
  }

  const cacheKey = cacheKeyForParams(params);
  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    return json(cached.payload, 200, {
      'Cache-Control': 'public, max-age=60'
    });
  }

  try {
    const payload = await fetchMidgardSwapHistory(params);
    await setCachedResponse(cacheKey, payload, CACHE_TTL_MS);
    return json(payload, 200, {
      'Cache-Control': 'public, max-age=60'
    });
  } catch (historyError) {
    const stale = await getCachedResponse(cacheKey, { allowStale: true });
    if (stale) {
      return json(
        {
          ...stale.payload,
          stale: true,
          warning: isMidgardRateLimitError(historyError)
            ? 'Served cached swap history after Midgard rate limit'
            : 'Served cached swap history after Midgard fetch failure'
        },
        200,
        {
          'Cache-Control': 'public, max-age=30'
        }
      );
    }

    throw historyError;
  }
}
