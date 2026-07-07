import { error, json, parseIntegerParam } from '../lib/http.js';
import { summarizeDuneError } from '../shared/dune.js';
import { fetchMidgardSwapHistory } from '../shared/midgard.js';
import { getCachedResponse, setCachedResponse } from '../shared/response-cache.js';
import { fetchRapidSwapMarketHistoryFromDune } from '../shared/rapid-swaps.js';

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
  return `dune:history:swaps:${normalized.toString()}`;
}

function intervalSeconds(interval) {
  if (interval === 'month') return 30 * 24 * 60 * 60;
  if (interval === 'week') return 7 * 24 * 60 * 60;
  if (interval === 'day') return 24 * 60 * 60;
  return 60 * 60;
}

function getDuneHistoryRange(params) {
  const to = Number(params.to || 0) > 0
    ? Number(params.to)
    : Math.floor(Date.now() / 1000);
  const from = Number(params.from || 0) > 0
    ? Number(params.from)
    : to - Math.max(1, Number(params.count || 24) || 24) * intervalSeconds(params.interval);
  return {
    from: Math.max(0, Math.trunc(from)),
    to: Math.max(Math.trunc(from), Math.trunc(to))
  };
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
    const range = getDuneHistoryRange(params);
    const payload = await fetchRapidSwapMarketHistoryFromDune({
      interval: params.interval,
      from: range.from,
      to: range.to
    });
    await setCachedResponse(cacheKey, payload, CACHE_TTL_MS);
    return json(payload, 200, {
      'Cache-Control': 'public, max-age=60'
    });
  } catch (historyError) {
    const range = getDuneHistoryRange(params);
    try {
      const midgardPayload = await fetchMidgardSwapHistory({
        interval: params.interval,
        from: String(range.from),
        to: String(range.to),
        ...(params.pool ? { pool: params.pool } : {})
      });
      const payload = {
        ...midgardPayload,
        meta: {
          ...(midgardPayload.meta || {}),
          source: 'midgard',
          fallback_for: 'dune'
        },
        stale: false,
        warning: 'Served Midgard swap history after Dune fetch failure',
        dune_error: summarizeDuneError(historyError)
      };
      await setCachedResponse(cacheKey, payload, CACHE_TTL_MS);
      return json(payload, 200, {
        'Cache-Control': 'public, max-age=60'
      });
    } catch (midgardError) {
      const stale = await getCachedResponse(cacheKey, { allowStale: true });
      if (stale) {
        return json(
          {
            ...stale.payload,
            stale: true,
            warning: 'Served cached swap history after Dune and Midgard fetch failures',
            dune_error: summarizeDuneError(historyError),
            midgard_error: midgardError.message || String(midgardError)
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
}
