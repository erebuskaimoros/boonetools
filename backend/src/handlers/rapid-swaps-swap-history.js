import { error, json, parseIntegerParam } from '../lib/http.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { selectRapidSwapMarketHistory } from '../shared/rapid-swaps-market-history.js';
import { getReadModel } from '../shared/read-models.js';
import { getCachedResponse } from '../shared/response-cache.js';

const ALLOWED_INTERVALS = new Set(['hour', 'day', 'week', 'month']);

export function buildRapidSwapHistoryParams(url) {
  const interval = String(url.searchParams.get('interval') || 'hour').toLowerCase();
  if (!ALLOWED_INTERVALS.has(interval)) throw new Error('Invalid interval parameter');
  const params = { interval };
  const pool = String(url.searchParams.get('pool') || '').trim();
  if (pool) params.pool = pool;
  const from = parseIntegerParam(url.searchParams.get('from'), 0, { min: 0 });
  const to = parseIntegerParam(url.searchParams.get('to'), 0, { min: 0 });
  const count = parseIntegerParam(url.searchParams.get('count'), 0, { min: 0, max: 400 });
  if (from > 0 || to > 0) {
    if (from <= 0 || to <= 0 || from > to) throw new Error('Invalid from/to parameters');
    params.from = String(from);
    params.to = String(to);
  } else if (count > 0) {
    params.count = String(count);
  }
  return params;
}

function cacheKeyForParams(params) {
  const normalized = new URLSearchParams();
  for (const key of Object.keys(params).sort()) normalized.set(key, String(params[key]));
  return `dune:history:swaps:${normalized.toString()}`;
}

export async function handleRapidSwapsSwapHistory(_request, url) {
  let params;
  try {
    params = buildRapidSwapHistoryParams(url);
  } catch (buildError) {
    return error(buildError.message || 'Invalid swap history parameters', 400);
  }

  // Pool-specific historical requests are not part of the compact global read
  // model. They may use a previously scheduled/cache-warmed exact response, but
  // never trigger a provider call from the public request path.
  if (params.pool) {
    const cached = await getCachedResponse(cacheKeyForParams(params), { allowStale: true });
    if (cached) {
      return json({
        ...cached.payload,
        stale: Boolean(cached.stale),
        ...(cached.stale ? { warning: 'Serving the last cached pool history snapshot' } : {})
      }, 200, {
        'Cache-Control': cached.stale ? 'public, max-age=30' : 'public, max-age=60',
        'X-Boone-Cache': cached.stale ? 'legacy-cache-stale' : 'legacy-cache'
      });
    }
    return json({
      error: 'Pool-specific swap history is not precomputed',
      retryable: false
    }, 503, { 'Cache-Control': 'no-store' });
  }

  const model = await getReadModel(ANALYTICS_READ_MODEL_KEYS.rapidSwapMarketHistory);
  if (!model) {
    return json({
      error: 'Swap-history snapshot is warming',
      retryable: true,
      model_key: ANALYTICS_READ_MODEL_KEYS.rapidSwapMarketHistory
    }, 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '60'
    });
  }
  const payload = selectRapidSwapMarketHistory(model.payload, params);
  if (payload?.unavailable) {
    return json({
      error: 'Requested range predates the precomputed swap-history window',
      earliest: payload.earliest,
      requested_from: payload.requested_from
    }, 416, { 'Cache-Control': 'no-store' });
  }
  const responsePayload = payload || { intervals: [] };
  const stale = Boolean(model.stale || model.payload?.stale || responsePayload.stale);
  const sourceUpdatedAt = responsePayload.meta?.source_updated_at
    || model.sourceUpdatedAt
    || model.payload?.source_updated_at
    || null;
  const sourceUpdatedMs = Date.parse(sourceUpdatedAt || '');
  const sourceAgeSeconds = Number.isFinite(sourceUpdatedMs)
    ? Math.max(0, Math.floor((Date.now() - sourceUpdatedMs) / 1000))
    : null;
  const headers = {
    'Cache-Control': stale ? 'public, max-age=30' : 'public, max-age=60',
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0),
    ...(sourceAgeSeconds == null ? {} : { 'X-Boone-Source-Age': String(sourceAgeSeconds) })
  };
  return json(stale ? {
    ...responsePayload,
    stale: true,
    warning: responsePayload.warning || 'Serving the last successful swap-history snapshot'
  } : responsePayload, 200, {
    ...headers
  });
}
