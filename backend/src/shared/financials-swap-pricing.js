const price = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const timestamp = value => typeof value === 'number' ? value * 1000 : Date.parse(value);

/** Only a containing source interval can price a fee. Native RUNE prices from
 * the action are a fallback; an adjacent day's price is never substituted. */
export function priceFinancialSwapRowsAtPrices(rows, prices = []) {
  return rows.map(row => {
    const at = Date.parse(row.feeTimestamp || row.timestamp);
    const interval = prices.find(item => at >= timestamp(item.from) && at < timestamp(item.to) && price(item.price));
    const runePrice = price(interval?.price) ?? price(row.runePriceUsd);
    const feeRune = typeof row.feeRune === 'number' && Number.isFinite(row.feeRune) && row.feeRune >= 0 ? row.feeRune : null;
    const amount = feeRune !== null && runePrice !== null ? feeRune * runePrice : null;
    const feeUsd = Number.isFinite(amount) ? amount : null;
    return { ...row, feeUsd, feeRate: feeUsd !== null && typeof row.volumeUsd === 'number' && row.volumeUsd > 0
      ? feeUsd / row.volumeUsd : null };
  });
}

/** Read cached prices once for the requested interval. Completed UTC-day closes
 * are an explicit fallback after exact fifteen-minute observations, followed
 * by the matching earnings interval and a native RUNE action's own price. */
export async function priceFinancialSwapRows(client, rows, { from, to, prices = [] } = {}) {
  if (!rows.length) return [];
  const instants = rows.map(row => Date.parse(row.feeTimestamp || row.timestamp)).filter(Number.isFinite);
  if (!instants.length) return priceFinancialSwapRowsAtPrices(rows, prices);
  const start = Number.isFinite(from) ? from * 1000 : instants.reduce((a, b) => Math.min(a, b), Infinity);
  const end = Number.isFinite(to) ? to * 1000 : instants.reduce((a, b) => Math.max(a, b), -Infinity) + 1;
  const snapshots = (await client.query(`select distinct on (bucket_end) bucket_end, rune_price_usd::text
    from pool_analysis_intraday_snapshots where asset = any(array['BTC.BTC','ETH.ETH'])
      and rune_price_usd > 0 and bucket_end > $1::timestamptz and bucket_end <= $2::timestamptz
    order by bucket_end, asset`, [new Date(Math.floor(start / 900_000) * 900_000).toISOString(),
    new Date(Math.ceil(end / 900_000) * 900_000).toISOString()])).rows;
  const daily = (await client.query(`select distinct on (day) day::text, rune_price_usd::text
    from pool_analysis_daily where asset = any(array['BTC.BTC','ETH.ETH']) and rune_price_usd > 0 and not partial
      and day >= ($1::timestamptz at time zone 'UTC')::date and day <= ($2::timestamptz at time zone 'UTC')::date
    order by day, asset`, [new Date(start).toISOString(), new Date(end).toISOString()])).rows;
  return priceFinancialSwapRowsAtPrices(rows, [
    ...snapshots.map(row => ({ from: new Date(row.bucket_end).getTime() / 1000 - 900,
      to: new Date(row.bucket_end).getTime() / 1000, price: row.rune_price_usd })),
    ...prices,
    ...daily.map(row => ({ from: Date.parse(`${row.day}T00:00:00Z`) / 1000,
      to: Date.parse(`${row.day}T00:00:00Z`) / 1000 + 86400, price: row.rune_price_usd }))
  ]);
}
