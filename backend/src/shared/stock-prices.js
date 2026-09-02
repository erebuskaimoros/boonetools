import { requestFromProviders } from '../lib/provider-client.js';
import { acquireCached } from './acquisition-cache.js';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
export const ALLOWED_SYMBOLS = ['SPY', 'VT', 'GC=F'];

export async function fetchYahooQuote(symbol, from, to) {
  const params = new URLSearchParams();

  if (from && to) {
    params.set('period1', String(from));
    params.set('period2', String(to));
    params.set('interval', '1d');
  } else {
    params.set('range', '1d');
    params.set('interval', '1d');
  }

  const path = `/${encodeURIComponent(symbol)}?${params}`;
  const data = await requestFromProviders({
    bases: [YAHOO_BASE],
    path,
    timeoutMs: 10_000,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json'
    },
    errorMessage: ({ status }) => `Yahoo Finance ${symbol}: ${status}`
  });
  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo Finance ${symbol}: no data`);
  }

  if (from && to) {
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points = [];

    for (let index = 0; index < timestamps.length; index += 1) {
      const close = closes[index];
      if (close != null && Number.isFinite(close)) {
        points.push([timestamps[index], close]);
      }
    }

    return points;
  }

  const meta = result.meta;
  const price = meta?.regularMarketPrice ?? meta?.previousClose ?? 0;
  return Number(price) || 0;
}

export async function fetchStockPrices(symbols, options = {}) {
  const uniqueSymbols = Array.from(new Set((Array.isArray(symbols) ? symbols : []).filter((symbol) => ALLOWED_SYMBOLS.includes(symbol))));

  if (uniqueSymbols.length === 0) {
    throw new Error(`No valid symbols. Allowed: ${ALLOWED_SYMBOLS.join(', ')}`);
  }

  const from = options.from ? Number(options.from) : undefined;
  const to = options.to ? Number(options.to) : undefined;
  const isHistorical = from && to && Number.isFinite(from) && Number.isFinite(to);
  const cacheSeconds = isHistorical ? 3600 : 300;
  const fetchQuote = options.fetchQuote || fetchYahooQuote;

  const results = await Promise.allSettled(
    uniqueSymbols.map(async (symbol) => (await acquireCached(options.client, {
      namespace: 'yahoo-chart:v1', identity: { symbol, from: isHistorical ? from : null, to: isHistorical ? to : null },
      source: 'yahoo', ttlMs: cacheSeconds * 1000, nowMs: options.nowMs,
      load: () => fetchQuote(symbol, isHistorical ? from : undefined, isHistorical ? to : undefined),
      validate: (payload) => isHistorical
        ? Array.isArray(payload) && payload.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
        : Number.isFinite(payload) && payload > 0
    })).payload)
  );

  const prices = {};
  for (let index = 0; index < uniqueSymbols.length; index += 1) {
    const result = results[index];
    prices[uniqueSymbols[index]] = result.status === 'fulfilled' ? result.value : null;
  }

  return {
    prices,
    cacheSeconds
  };
}
