import { requestFromProviders } from '../lib/provider-client.js';

const COINGECKO_BASE = 'https://api.coingecko.com';
const COINGECKO_PATH = '/api/v3/simple/price?ids=thorchain%2Cmonero%2Czcash&vs_currencies=usd%2Ceur%2Cgbp%2Cjpy%2Cbtc%2Cxau';

export const CURRENCY_RATES_TTL_MS = 10 * 60 * 1000;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeCoinGeckoRates(payload) {
  const rune = payload?.thorchain;
  const runeUsd = positiveNumber(rune?.usd);
  if (!rune || runeUsd == null) {
    throw new Error('CoinGecko returned no usable THORChain USD price');
  }

  const rates = {};
  for (const [currency, field] of [
    ['USD', 'usd'],
    ['EUR', 'eur'],
    ['GBP', 'gbp'],
    ['JPY', 'jpy'],
    ['BTC', 'btc'],
    ['XAU', 'xau']
  ]) {
    const value = positiveNumber(rune[field]);
    if (value != null) rates[currency] = value;
  }

  const moneroUsd = positiveNumber(payload?.monero?.usd);
  const zcashUsd = positiveNumber(payload?.zcash?.usd);
  if (moneroUsd != null) rates.XMR = runeUsd / moneroUsd;
  if (zcashUsd != null) rates.ZEC = runeUsd / zcashUsd;

  return rates;
}

/**
 * Fetch every current CoinGecko-backed display rate in one provider request.
 * The service below owns request coalescing and cadence; this function only
 * handles provider transport and response normalization.
 */
export async function fetchCoinGeckoCurrencyRates(options = {}) {
  const payload = await requestFromProviders({
    bases: [COINGECKO_BASE],
    path: COINGECKO_PATH,
    timeoutMs: 10_000,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'BooneTools/1.0'
    },
    validateResponse: (data) => (
      positiveNumber(data?.thorchain?.usd) == null
        ? 'CoinGecko returned no usable THORChain USD price'
        : null
    ),
    errorMessage: ({ status }) => `CoinGecko currency rates: HTTP ${status}`
  });

  return normalizeCoinGeckoRates(payload);
}

function isoTimestamp(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function normalizeRates(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw new Error('Currency-rate provider returned an invalid response');
  }

  const normalized = {};
  for (const [currency, rawValue] of Object.entries(rates)) {
    const value = positiveNumber(rawValue);
    if (value != null) normalized[currency] = value;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error('Currency-rate provider returned no usable rates');
  }
  return normalized;
}

function coverageWarnings(rates) {
  const expectedCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'BTC', 'XAU', 'XMR', 'ZEC'];
  const missing = expectedCurrencies.filter((currency) => rates[currency] == null);
  return missing.length > 0
    ? [`Currency-rate provider omitted: ${missing.join(', ')}`]
    : [];
}

/**
 * Build a process-local, single-flight cache. Both successful requests and
 * failed refresh attempts advance nextRefreshAt so a provider outage cannot
 * turn visitor traffic into a retry storm.
 */
export function createCurrencyRatesService(options = {}) {
  const now = options.now || Date.now;
  const fetchRates = options.fetchRates || (() => fetchCoinGeckoCurrencyRates(options));
  const ttlMs = Math.max(1, Math.trunc(Number(options.ttlMs) || CURRENCY_RATES_TTL_MS));

  let lastGood = null;
  let lastFailure = null;
  let nextRefreshAtMs = 0;
  let inFlight = null;

  function result(cacheStatus, stale = false) {
    const nowMs = Number(now());
    const warnings = [
      ...(lastGood.warnings || []),
      ...(lastGood.degraded ? ['Only USD display is available'] : []),
      ...(lastFailure
        ? [lastGood.degraded
          ? 'CoinGecko is unavailable; using the USD-only fallback'
          : 'Serving the last successful currency rates after a CoinGecko failure']
        : [])
    ];
    return {
      rates: { ...lastGood.rates },
      cacheStatus,
      fetchedAt: isoTimestamp(lastGood.fetchedAtMs),
      stale,
      ageSeconds: Math.max(0, Math.floor((nowMs - lastGood.fetchedAtMs) / 1000)),
      refreshAfter: isoTimestamp(Math.max(nowMs, nextRefreshAtMs)),
      warnings: [...new Set(warnings)]
    };
  }

  async function refresh() {
    const attemptAtMs = Number(now());
    nextRefreshAtMs = attemptAtMs + ttlMs;

    try {
      // Resolve through a microtask so even a synchronously throwing injected
      // provider cannot leave the single-flight pointer stuck on a rejection.
      const rates = normalizeRates(await Promise.resolve().then(fetchRates));
      const fetchedAtMs = Number(now());
      const degraded = Object.keys(rates).length === 1 && rates.USD === 1;
      lastGood = {
        rates,
        fetchedAtMs,
        degraded,
        warnings: coverageWarnings(rates)
      };
      lastFailure = null;
      // A slow provider request still earns a full cache interval.
      nextRefreshAtMs = fetchedAtMs + ttlMs;
      return result(degraded ? 'stale' : 'miss', degraded);
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error(String(error));
      if (lastGood) return result('stale', true);
      lastGood = {
        rates: { USD: 1 },
        fetchedAtMs: attemptAtMs,
        degraded: true,
        warnings: []
      };
      return result('stale', true);
    } finally {
      inFlight = null;
    }
  }

  async function getRates() {
    const nowMs = Number(now());
    if (lastGood && nowMs < nextRefreshAtMs) {
      const stale = Boolean(lastFailure || lastGood.degraded);
      return result(stale ? 'stale' : 'hit', stale);
    }
    if (!lastGood && lastFailure && nowMs < nextRefreshAtMs) {
      throw lastFailure;
    }
    if (inFlight) return inFlight;

    inFlight = refresh();
    return inFlight;
  }

  return { getRates };
}

export const currencyRatesService = createCurrencyRatesService();
