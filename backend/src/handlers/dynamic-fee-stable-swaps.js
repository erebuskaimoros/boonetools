import { error, json, parseIntegerParam } from '../lib/http.js';
import { TtlSingleFlightCache } from '../lib/ttl-cache.js';
import { readStableSwapDays } from '../shared/dynamic-fee-stable-swaps.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 400;
// The candidate table is large; one aggregate per minute serves every visitor.
const CACHE_TTL_MS = 60_000;
const requestCache = new TtlSingleFlightCache({ ttlMs: CACHE_TTL_MS });

export function buildDynamicFeeStableSwapsParams(url, nowMs = Date.now()) {
  const days = parseIntegerParam(url.searchParams.get('days'), MAX_DAYS, { min: 1, max: MAX_DAYS });
  return { days, nowMs, currentDay: new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString().slice(0, 10) };
}

function cacheKey(params) {
  return ['dynamic-fee-stable-swaps:v1', params.days, params.currentDay].join(':');
}

export async function handleDynamicFeeStableSwaps(_request, url) {
  let params;
  try {
    params = buildDynamicFeeStableSwapsParams(url);
  } catch (buildError) {
    return error(buildError.message || 'Invalid stable swap parameters', 400);
  }

  const key = cacheKey(params);
  const memoryCached = requestCache.get(key);
  const resolved = memoryCached || await requestCache.getOrLoad(key, async () => {
    const { getClient } = await import('../db/pool.js');
    const client = await getClient();
    try { return { payload: await readStableSwapDays(client, params) }; }
    finally { client.release(); }
  });

  return json(resolved.payload, 200, {
    'Cache-Control': 'public, max-age=60',
    'X-Boone-Cache': memoryCached ? 'memory' : 'database'
  });
}
