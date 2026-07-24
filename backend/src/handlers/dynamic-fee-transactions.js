import { error, json, parseIntegerParam } from '../lib/http.js';
import { TtlSingleFlightCache } from '../lib/ttl-cache.js';
import { getDynamicFeeEpochTransactions } from '../shared/dynamic-fee-transactions.js';
import { getCachedResponse, setCachedResponse } from '../shared/response-cache.js';

const SEALED_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 15 * 1000;
const VALID_IDENTIFIER = /^[a-z0-9._-]{1,128}$/i;
const VALID_ASSET = /^[a-z0-9._~:-]{1,192}$/i;
const VALID_PAIR = /^[a-z0-9._~:-]{1,192}\|[a-z0-9._~:-]{1,192}$/i;
const requestCache = new TtlSingleFlightCache({ ttlMs: LIVE_CACHE_TTL_MS });

function buildParams(url) {
  const affiliate = String(url.searchParams.get('affiliate') || '').trim();
  const asset = String(url.searchParams.get('asset') || '').trim();
  const pair = String(url.searchParams.get('pair') || '').trim();
  const startHeight = parseIntegerParam(url.searchParams.get('start_height'), 0, { min: 1 });
  const endHeight = parseIntegerParam(url.searchParams.get('end_height'), 0, { min: 1 });
  const epochBlocks = parseIntegerParam(url.searchParams.get('epoch_blocks'), 0, {
    min: 1,
    max: 100_000
  });
  const live = url.searchParams.get('live') === 'true';

  if (!VALID_IDENTIFIER.test(affiliate)) throw new Error('Invalid affiliate parameter');
  if (!VALID_ASSET.test(asset)) throw new Error('Invalid asset parameter');
  if (!VALID_PAIR.test(pair)) throw new Error('Invalid pair parameter');
  if (!startHeight || !endHeight || startHeight > endHeight) {
    throw new Error('Invalid epoch block range');
  }
  if (!epochBlocks || endHeight - startHeight + 1 > epochBlocks) {
    throw new Error('Epoch block range exceeds epoch_blocks');
  }

  return {
    affiliate,
    asset,
    pair,
    epochBlocks,
    range: { startHeight, endHeight, live }
  };
}

function cacheKey(params) {
  return [
    'dynamic-fee-transactions:v1',
    params.affiliate.toLowerCase(),
    params.asset.toUpperCase(),
    params.pair.toUpperCase(),
    params.range.startHeight,
    params.range.endHeight,
    params.range.live ? 'live' : 'sealed'
  ].join(':');
}

export async function handleDynamicFeeTransactions(_request, url) {
  let params;
  try {
    params = buildParams(url);
  } catch (buildError) {
    return error(buildError.message || 'Invalid dynamic fee transaction parameters', 400);
  }

  const key = cacheKey(params);
  const memoryCached = requestCache.get(key);
  const resolved = memoryCached || await requestCache.getOrLoad(key, async () => {
    const cached = await getCachedResponse(key);
    if (cached) return { payload: cached.payload, cacheStatus: 'persistent' };

    const result = await getDynamicFeeEpochTransactions(params);
    const payload = {
      ...result,
      pair: params.pair,
      start_height: params.range.startHeight,
      end_height: params.range.endHeight,
      live: params.range.live,
      fee_volume_basis: 'selected-pair-executed-leg-rune',
      display_volume_basis: 'route-input-usd',
      source: 'midgard-actions+thornode-swap-events'
    };
    await setCachedResponse(
      key,
      payload,
      params.range.live ? LIVE_CACHE_TTL_MS : SEALED_CACHE_TTL_MS
    );
    return { payload, cacheStatus: 'miss' };
  });

  return json(resolved.payload, 200, {
    'Cache-Control': params.range.live ? 'public, max-age=5' : 'public, max-age=86400',
    'X-Boone-Cache': memoryCached ? 'memory' : resolved.cacheStatus
  });
}
