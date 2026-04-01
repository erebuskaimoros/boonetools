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

  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?${params}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance ${symbol}: ${response.status}`);
  }

  const data = await response.json();
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

  const results = await Promise.allSettled(
    uniqueSymbols.map((symbol) => fetchYahooQuote(symbol, isHistorical ? from : undefined, isHistorical ? to : undefined))
  );

  const prices = {};
  for (let index = 0; index < uniqueSymbols.length; index += 1) {
    const result = results[index];
    prices[uniqueSymbols[index]] = result.status === 'fulfilled' ? result.value : null;
  }

  return {
    prices,
    cacheSeconds: isHistorical ? 3600 : 300
  };
}
