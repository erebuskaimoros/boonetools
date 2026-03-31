import {
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  requireMethod
} from '../_shared/validation.ts';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const ALLOWED_SYMBOLS = ['SPY', 'VT', 'GC=F'];

async function fetchYahooQuote(symbol: string, from?: number, to?: number): Promise<number | number[][]> {
  const params = new URLSearchParams();

  if (from && to) {
    // Historical mode: daily data between timestamps
    params.set('period1', String(from));
    params.set('period2', String(to));
    params.set('interval', '1d');
  } else {
    // Current price mode
    params.set('range', '1d');
    params.set('interval', '1d');
  }

  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance ${symbol}: ${res.status}`);
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance ${symbol}: no data`);

  if (from && to) {
    // Return array of [timestamp, close] pairs
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points: number[][] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close != null && Number.isFinite(close)) {
        points.push([timestamps[i], close]);
      }
    }
    return points;
  } else {
    // Return latest close price
    const meta = result.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose ?? 0;
    return Number(price) || 0;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const methodError = requireMethod(req, 'GET');
  if (methodError) return errorResponse(methodError, 405);

  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get('symbols') || '';
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');

  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(s => ALLOWED_SYMBOLS.includes(s));
  if (symbols.length === 0) {
    return errorResponse('No valid symbols. Allowed: ' + ALLOWED_SYMBOLS.join(', '), 400);
  }

  const from = fromParam ? Number(fromParam) : undefined;
  const to = toParam ? Number(toParam) : undefined;
  const isHistorical = from && to && Number.isFinite(from) && Number.isFinite(to);

  try {
    const results = await Promise.allSettled(
      symbols.map(s => fetchYahooQuote(s, isHistorical ? from : undefined, isHistorical ? to : undefined))
    );

    const prices: Record<string, number | number[][] | null> = {};
    for (let i = 0; i < symbols.length; i++) {
      const r = results[i];
      prices[symbols[i]] = r.status === 'fulfilled' ? r.value : null;
    }

    const cacheSeconds = isHistorical ? 3600 : 300;
    return jsonResponse(prices, 200, {
      'Cache-Control': `public, max-age=${cacheSeconds}`
    });
  } catch (err) {
    console.error('stock-prices error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Internal error', 500);
  }
});
