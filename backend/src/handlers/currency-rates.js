import { error, json } from '../lib/http.js';
import {
  CURRENCY_RATES_TTL_MS,
  currencyRatesService
} from '../shared/currency-rates.js';

function remainingCacheSeconds(refreshAfter) {
  const refreshAtMs = Date.parse(String(refreshAfter || ''));
  if (!Number.isFinite(refreshAtMs)) return Math.floor(CURRENCY_RATES_TTL_MS / 1000);
  return Math.max(0, Math.ceil((refreshAtMs - Date.now()) / 1000));
}

export async function handleCurrencyRates(_request, _url, options = {}) {
  const service = options.service || currencyRatesService;

  try {
    const result = await service.getRates();
    const maxAge = remainingCacheSeconds(result.refreshAfter);
    const headers = {
      'Cache-Control': result.stale
        ? `public, max-age=${maxAge}, stale-if-error=86400`
        : `public, max-age=${maxAge}, stale-while-revalidate=60, stale-if-error=86400`,
      'X-Boone-Age': String(result.ageSeconds ?? 0),
      'X-Boone-Cache': result.cacheStatus
    };

    return json({
      rates: result.rates,
      fetched_at: result.fetchedAt,
      stale: result.stale,
      cache_status: result.cacheStatus,
      ...(result.warnings?.length ? { warnings: result.warnings } : {})
    }, 200, headers);
  } catch (providerError) {
    console.error(JSON.stringify({
      type: 'currency_rates_provider_error',
      message: providerError?.message || 'Currency rates are unavailable'
    }));
    return error('Currency rates are temporarily unavailable', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': String(Math.floor(CURRENCY_RATES_TTL_MS / 1000)),
      'X-Boone-Cache': 'unavailable'
    });
  }
}
