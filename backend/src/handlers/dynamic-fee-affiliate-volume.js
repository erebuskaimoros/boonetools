import { error, json, parseIntegerParam } from '../lib/http.js';
import { TtlSingleFlightCache } from '../lib/ttl-cache.js';
import { readAffiliateVolume } from '../shared/dynamic-fee-affiliate-ingestion.js';

const DAY_SECONDS = 24 * 60 * 60;
const MAX_DAYS = 400;
const MAX_TRANSACTION_DAYS = 31;
const CACHE_TTL_MS = 3_000;
const VALID_IDENTIFIER = /^[a-z0-9._-]{1,128}$/i;
const requestCache = new TtlSingleFlightCache({ ttlMs: CACHE_TTL_MS });

export function buildDynamicFeeAffiliateVolumeParams(url, nowMs = Date.now()) {
  const affiliate = String(url.searchParams.get('affiliate') || '').trim();
  const days = parseIntegerParam(url.searchParams.get('days'), 400, {
    min: 1,
    max: MAX_DAYS
  });
  if (!VALID_IDENTIFIER.test(affiliate)) throw new Error('Invalid affiliate parameter');

  const requestedTo = parseIntegerParam(url.searchParams.get('to'), 0, { min: 0 });
  const includeTransactions = url.searchParams.get('include_transactions') === 'true';
  if (includeTransactions && days > MAX_TRANSACTION_DAYS) {
    throw new Error(`Transaction drilldowns are limited to ${MAX_TRANSACTION_DAYS} days`);
  }
  const currentDayStart = Math.floor(nowMs / 1000 / DAY_SECONDS) * DAY_SECONDS;
  const toTimestamp = requestedTo > 0 ? Math.min(requestedTo, currentDayStart + DAY_SECONDS) : currentDayStart + DAY_SECONDS;
  if (toTimestamp % DAY_SECONDS !== 0) throw new Error('Affiliate history must use UTC day boundaries');
  const fromTimestamp = toTimestamp - days * DAY_SECONDS;

  return { affiliate, days, fromTimestamp, toTimestamp, includeTransactions };
}

function cacheKey(params) {
  return [
    'dynamic-fee-affiliate-volume:v4',
    params.affiliate.toLowerCase(),
    params.fromTimestamp,
    params.toTimestamp,
    params.includeTransactions ? 'transactions' : 'summary'
  ].join(':');
}

export async function handleDynamicFeeAffiliateVolume(_request, url) {
  let params;
  try {
    params = buildDynamicFeeAffiliateVolumeParams(url);
  } catch (buildError) {
    return error(buildError.message || 'Invalid affiliate volume parameters', 400);
  }

  const key = cacheKey(params);
  const memoryCached = requestCache.get(key);
  const resolved = memoryCached || await requestCache.getOrLoad(key, async () => {
    const { getClient } = await import('../db/pool.js');
    const client = await getClient();
    try { return { payload: await readAffiliateVolume(client, params), cacheStatus: 'persistent' }; }
    finally { client.release(); }
  });

  return json(resolved.payload, 200, {
    'Cache-Control': resolved.payload.partial ? 'public, max-age=5' : 'public, max-age=60',
    'X-Boone-Cache': memoryCached ? 'memory' : resolved.cacheStatus
  });
}
