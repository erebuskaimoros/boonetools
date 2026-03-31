/**
 * Currency Store - Multi-currency support for RUNE Tools
 *
 * Supports 10 currencies: USD, EUR, GBP, JPY, BTC, XMR, ZEC, XAU, SPY, VT
 *
 * USAGE:
 *
 * 1. Import in your component:
 *    import {
 *      currentCurrency, exchangeRates, currencyConfig,
 *      initCurrency, setCurrency, formatCurrency, formatCurrencyWithDecimals,
 *      getCurrencySymbol, formatCurrencyCompact, fetchHistoricalRates
 *    } from '$lib/stores/currency';
 *
 * 2. Initialize on mount: onMount(() => initCurrency());
 *
 * 3. Use reactive values:
 *    $: formatted = formatCurrency($exchangeRates, valueInUSD, $currentCurrency);
 */

import { writable } from 'svelte/store';

// ---- Configuration ----

export const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'BTC', 'XMR', 'ZEC', 'XAU', 'SPY', 'VT'];

export const currencyConfig = {
  USD: { symbol: '$',    decimals: 0, preciseDecimals: 2, isISO: true,  label: 'US Dollar' },
  EUR: { symbol: '\u20AC', decimals: 0, preciseDecimals: 2, isISO: true,  label: 'Euro' },
  GBP: { symbol: '\u00A3', decimals: 0, preciseDecimals: 2, isISO: true,  label: 'British Pound' },
  JPY: { symbol: '\u00A5', decimals: 0, preciseDecimals: 0, isISO: true,  label: 'Japanese Yen' },
  BTC: { symbol: '\u20BF', decimals: 6, preciseDecimals: 8, isISO: false, label: 'Bitcoin' },
  XMR: { symbol: 'XMR ',   decimals: 4, preciseDecimals: 6, isISO: false, label: 'Monero' },
  ZEC: { symbol: 'ZEC ',   decimals: 4, preciseDecimals: 6, isISO: false, label: 'Zcash' },
  XAU: { symbol: 'XAU ',   decimals: 4, preciseDecimals: 4, isISO: false, label: 'Gold (oz)' },
  SPY: { symbol: 'SPY ',   decimals: 2, preciseDecimals: 4, isISO: false, label: 'S&P 500 ETF' },
  VT:  { symbol: 'VT ',    decimals: 2, preciseDecimals: 4, isISO: false, label: 'World Stock ETF' },
};

// Legacy compat
export const currencySymbols = Object.fromEntries(
  Object.entries(currencyConfig).map(([k, v]) => [k, v.symbol])
);

// ---- Stores ----

export const currentCurrency = writable('USD');
export const exchangeRates = writable({});

// ---- Rate Fetching ----

const STOCK_PRICES_BASE = (import.meta.env.VITE_NODEOP_API_BASE || '').replace(/\/$/, '');
const STOCK_PRICES_KEY = import.meta.env.VITE_NODEOP_API_KEY || '';

export async function fetchExchangeRates() {
  const results = await Promise.allSettled([
    // 1. RUNE price in fiat + BTC + XAU
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=thorchain&vs_currencies=usd,eur,gbp,jpy,btc,xau')
      .then(r => r.ok ? r.json() : null),
    // 2. XMR and ZEC prices in USD
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero,zcash&vs_currencies=usd')
      .then(r => r.ok ? r.json() : null),
    // 3. SPY, VT, gold from stock-prices proxy
    STOCK_PRICES_BASE
      ? fetch(`${STOCK_PRICES_BASE}/stock-prices?symbols=SPY,VT,GC=F`, {
          headers: { apikey: STOCK_PRICES_KEY, Authorization: `Bearer ${STOCK_PRICES_KEY}` }
        }).then(r => r.ok ? r.json() : null)
      : Promise.resolve(null)
  ]);

  const rates = {};
  const runeData = results[0].status === 'fulfilled' ? results[0].value?.thorchain : null;
  const cryptoData = results[1].status === 'fulfilled' ? results[1].value : null;
  const stockData = results[2].status === 'fulfilled' ? results[2].value : null;

  // Direct RUNE prices from CoinGecko (same format the frontend expects)
  if (runeData) {
    if (runeData.usd) rates.USD = runeData.usd;
    if (runeData.eur) rates.EUR = runeData.eur;
    if (runeData.gbp) rates.GBP = runeData.gbp;
    if (runeData.jpy) rates.JPY = runeData.jpy;
    if (runeData.btc) rates.BTC = runeData.btc;
    if (runeData.xau) rates.XAU = runeData.xau;
  }

  // XMR/ZEC: compute RUNE price in XMR/ZEC
  // rates.XMR = RUNE_USD / XMR_USD (how many XMR per 1 RUNE)
  if (rates.USD && cryptoData) {
    if (cryptoData.monero?.usd) rates.XMR = rates.USD / cryptoData.monero.usd;
    if (cryptoData.zcash?.usd) rates.ZEC = rates.USD / cryptoData.zcash.usd;
  }

  // SPY/VT: compute RUNE price in shares
  // rates.SPY = RUNE_USD / SPY_USD (how many SPY shares per 1 RUNE)
  if (rates.USD && stockData) {
    if (stockData.SPY) rates.SPY = rates.USD / stockData.SPY;
    if (stockData.VT) rates.VT = rates.USD / stockData.VT;
    // Gold fallback from Yahoo if CoinGecko XAU failed
    if (!rates.XAU && stockData['GC=F']) rates.XAU = rates.USD / stockData['GC=F'];
  }

  exchangeRates.set(rates);
}

// ---- Historical Rates (on-demand) ----

const historicalCache = new Map(); // currency -> Map<timestamp, usdPriceOfAsset>

const COINGECKO_IDS = { BTC: 'bitcoin', XMR: 'monero', ZEC: 'zcash' };
const YAHOO_SYMBOLS = { SPY: 'SPY', VT: 'VT', XAU: 'GC=F' };

/**
 * Fetch historical USD prices for a given currency/asset.
 * Returns a sorted array of [timestamp, usdPriceOfAsset] pairs.
 * For fiat currencies, returns [timestamp, runePrice_in_fiat] (same format as rates store).
 * Cached after first fetch.
 */
export async function fetchHistoricalRates(currency, fromTimestamp, toTimestamp) {
  if (currency === 'USD') return [];

  const cacheKey = `${currency}_${fromTimestamp}_${toTimestamp}`;
  if (historicalCache.has(cacheKey)) return historicalCache.get(cacheKey);

  let points = [];

  try {
    if (['EUR', 'GBP', 'JPY'].includes(currency)) {
      // Fiat: get historical RUNE price in that currency from CoinGecko
      // Also get RUNE/USD to compute the fiat/USD rate
      const [fiatRes, usdRes] = await Promise.all([
        fetch(`https://api.coingecko.com/api/v3/coins/thorchain/market_chart/range?vs_currency=${currency.toLowerCase()}&from=${fromTimestamp}&to=${toTimestamp}`).then(r => r.ok ? r.json() : null),
        fetch(`https://api.coingecko.com/api/v3/coins/thorchain/market_chart/range?vs_currency=usd&from=${fromTimestamp}&to=${toTimestamp}`).then(r => r.ok ? r.json() : null)
      ]);

      if (fiatRes?.prices && usdRes?.prices) {
        // Build a map of timestamp -> rune_fiat / rune_usd = fiat_per_usd
        // But actually, for the frontend we need to store the rate in the same format
        // as the rates store: rates[currency] = RUNE price in that currency
        // The frontend converts: valueInUSD * (rates[currency] / rates.USD)
        // So we need both rune_fiat and rune_usd at each point

        // Pair up the closest timestamps
        const usdMap = new Map(usdRes.prices.map(([t, p]) => [Math.floor(t / 86400000), p]));
        for (const [t, fiatPrice] of fiatRes.prices) {
          const dayKey = Math.floor(t / 86400000);
          const usdPrice = usdMap.get(dayKey);
          if (usdPrice && fiatPrice) {
            // Store as { timestamp, runeInFiat, runeInUsd } so frontend can compute rate
            points.push([Math.floor(t / 1000), fiatPrice, usdPrice]);
          }
        }
      }
    } else if (COINGECKO_IDS[currency]) {
      // Crypto: get historical USD price of the asset
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${COINGECKO_IDS[currency]}/market_chart/range?vs_currency=usd&from=${fromTimestamp}&to=${toTimestamp}`
      );
      if (res.ok) {
        const data = await res.json();
        points = (data.prices || []).map(([t, p]) => [Math.floor(t / 1000), p]);
      }
    } else if (YAHOO_SYMBOLS[currency]) {
      // Stocks/Gold: use our stock-prices proxy
      if (STOCK_PRICES_BASE) {
        const res = await fetch(
          `${STOCK_PRICES_BASE}/stock-prices?symbols=${YAHOO_SYMBOLS[currency]}&from=${fromTimestamp}&to=${toTimestamp}`,
          { headers: { apikey: STOCK_PRICES_KEY, Authorization: `Bearer ${STOCK_PRICES_KEY}` } }
        );
        if (res.ok) {
          const data = await res.json();
          const symbolData = data[YAHOO_SYMBOLS[currency]];
          if (Array.isArray(symbolData)) {
            points = symbolData; // Already [[timestamp, price], ...]
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to fetch historical rates for ${currency}:`, err);
  }

  historicalCache.set(cacheKey, points);
  return points;
}

/**
 * Interpolate a historical rate for a given timestamp from a sorted points array.
 * For fiat: points are [timestamp, runeInFiat, runeInUsd] — returns { fiat, usd }
 * For crypto/stocks: points are [timestamp, usdPrice] — returns the USD price of the asset
 */
export function interpolateRate(points, timestamp, isFiat = false) {
  if (!points || points.length === 0) return null;

  // Find the closest point by timestamp
  let closest = points[0];
  let minDiff = Math.abs(timestamp - points[0][0]);

  for (const p of points) {
    const diff = Math.abs(timestamp - p[0]);
    if (diff < minDiff) {
      minDiff = diff;
      closest = p;
    }
    if (p[0] > timestamp && minDiff < 86400) break; // Close enough (within 1 day)
  }

  if (isFiat) {
    return { fiat: closest[1], usd: closest[2] };
  }
  return closest[1]; // USD price of asset
}

// ---- Currency Selection ----

export function setCurrency(currency) {
  if (currencies.includes(currency)) {
    currentCurrency.set(currency);
    updateCurrencyURL(currency);
  }
}

export function switchCurrency() {
  currentCurrency.update(curr => {
    const idx = currencies.indexOf(curr);
    const next = currencies[(idx + 1) % currencies.length];
    updateCurrencyURL(next);
    return next;
  });
}

function updateCurrencyURL(currency) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location);
  if (currency !== 'USD') {
    url.searchParams.set('currency', currency);
  } else {
    url.searchParams.delete('currency');
  }
  window.history.pushState({}, '', url);
}

function readCurrencyFromURL() {
  if (typeof window === 'undefined') return 'USD';
  const urlParams = new URLSearchParams(window.location.search);
  const urlCurrency = urlParams.get('currency');
  if (urlCurrency && currencies.includes(urlCurrency.toUpperCase())) {
    return urlCurrency.toUpperCase();
  }
  return 'USD';
}

export async function initCurrency() {
  const urlCurrency = readCurrencyFromURL();
  currentCurrency.set(urlCurrency);
  await fetchExchangeRates();
}

// ---- Formatting ----

export function getCurrencySymbol(currency) {
  return currencyConfig[currency]?.symbol || currency + ' ';
}

/**
 * Format a USD value in the specified currency (large values, no decimals for fiat)
 */
export function formatCurrency(rates, valueInUSD, currency) {
  if (!rates || !rates[currency] || !rates.USD) return '--';

  const convertedValue = valueInUSD * (rates[currency] / rates.USD);
  const config = currencyConfig[currency];
  if (!config) return '--';

  if (config.isISO) {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(convertedValue);
    return formatted.replace(/^[^\d-]+/, config.symbol);
  }

  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: config.decimals,
    maximumFractionDigits: config.decimals
  }).format(convertedValue);
  return config.symbol + formatted;
}

/**
 * Format a USD value in the specified currency (precise, with decimals)
 */
export function formatCurrencyWithDecimals(rates, valueInUSD, currency) {
  if (!rates || !rates[currency] || !rates.USD) return '--';

  const convertedValue = valueInUSD * (rates[currency] / rates.USD);
  const config = currencyConfig[currency];
  if (!config) return '--';

  if (config.isISO) {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: config.preciseDecimals,
      maximumFractionDigits: config.preciseDecimals
    }).format(convertedValue);
    return formatted.replace(/^[^\d-]+/, config.symbol);
  }

  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: config.preciseDecimals,
    maximumFractionDigits: config.preciseDecimals
  }).format(convertedValue);
  return config.symbol + formatted;
}

/**
 * Format a USD value compactly for chart axis labels
 */
export function formatCurrencyCompact(valueInConverted, currency) {
  const config = currencyConfig[currency];
  if (!config) return String(valueInConverted);

  const abs = Math.abs(valueInConverted);
  let str;
  if (abs >= 1e9) str = (valueInConverted / 1e9).toFixed(1) + 'B';
  else if (abs >= 1e6) str = (valueInConverted / 1e6).toFixed(1) + 'M';
  else if (abs >= 1e3) str = (valueInConverted / 1e3).toFixed(1) + 'K';
  else str = valueInConverted.toFixed(Math.min(config.decimals, 2));

  return config.symbol + str;
}
