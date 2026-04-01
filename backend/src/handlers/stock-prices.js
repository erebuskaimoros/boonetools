import { error, json } from '../lib/http.js';
import { fetchStockPrices, ALLOWED_SYMBOLS } from '../shared/stock-prices.js';

export async function handleStockPrices(_request, url) {
  const symbolsParam = url.searchParams.get('symbols') || '';
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const symbols = symbolsParam
    .split(',')
    .map((symbol) => symbol.trim())
    .filter((symbol) => ALLOWED_SYMBOLS.includes(symbol));

  if (symbols.length === 0) {
    return error(`No valid symbols. Allowed: ${ALLOWED_SYMBOLS.join(', ')}`, 400);
  }

  const { prices, cacheSeconds } = await fetchStockPrices(symbols, {
    from,
    to
  });

  return json(prices, 200, {
    'Cache-Control': `public, max-age=${cacheSeconds}`
  });
}
