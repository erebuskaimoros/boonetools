import { POOL_DISLOCATION_RETENTION_DAYS } from './pool-dislocation.js';

function databaseRow(row = {}) {
  return {
    observed_at: row.observedAt,
    asset: row.asset,
    symbol: row.symbol,
    chain: row.chain,
    pool_status: row.poolStatus,
    pool_price_usd: row.poolPriceUsd,
    pool_balance_asset: row.poolBalanceAsset || null,
    pool_balance_rune: row.poolBalanceRune || null,
    oracle_symbol: row.oracleSymbol,
    oracle_price_usd: row.oraclePriceUsd,
    oracle_observed_at: row.oracleObservedAt,
    binance_symbol: row.binanceSymbol,
    binance_bid_usd: row.binanceBidUsd,
    binance_ask_usd: row.binanceAskUsd,
    binance_price_usd: row.binancePriceUsd,
    binance_observed_at: row.binanceObservedAt,
    source_skew_ms: row.sourceSkewMs,
    sample_origin: row.sampleOrigin || 'scheduled',
    thorchain_height: row.thorchainHeight || null,
    pool_price_method: row.poolPriceMethod || 'thornode-asset-tor',
    oracle_price_method: row.oraclePriceMethod
      || (row.oraclePriceUsd == null ? null : 'thornode-oracle'),
    binance_price_method: row.binancePriceMethod
      || (row.binancePriceUsd == null ? null : 'book-ticker-mid')
  };
}

export async function upsertPoolDislocationRows(client, rows = []) {
  if (!rows.length) return { rowCount: 0 };
  const payload = rows.map(databaseRow);
  return client.query(
    `insert into pool_dislocation_observations as current (
       observed_at, asset, symbol, chain, pool_status, pool_price_usd,
       pool_balance_asset, pool_balance_rune,
       oracle_symbol, oracle_price_usd, oracle_observed_at,
       binance_symbol, binance_bid_usd, binance_ask_usd,
       binance_price_usd, binance_observed_at, source_skew_ms,
       sample_origin, thorchain_height, pool_price_method,
       oracle_price_method, binance_price_method
     )
     select incoming.observed_at, incoming.asset, incoming.symbol, incoming.chain,
            incoming.pool_status, incoming.pool_price_usd,
            incoming.pool_balance_asset, incoming.pool_balance_rune,
            incoming.oracle_symbol, incoming.oracle_price_usd, incoming.oracle_observed_at,
            incoming.binance_symbol, incoming.binance_bid_usd, incoming.binance_ask_usd,
            incoming.binance_price_usd, incoming.binance_observed_at, incoming.source_skew_ms,
            incoming.sample_origin, incoming.thorchain_height, incoming.pool_price_method,
            incoming.oracle_price_method, incoming.binance_price_method
     from jsonb_to_recordset($1::jsonb) as incoming (
       observed_at timestamptz, asset text, symbol text, chain text, pool_status text,
       pool_price_usd numeric, pool_balance_asset numeric, pool_balance_rune numeric,
       oracle_symbol text, oracle_price_usd numeric, oracle_observed_at timestamptz,
       binance_symbol text, binance_bid_usd numeric, binance_ask_usd numeric,
       binance_price_usd numeric, binance_observed_at timestamptz, source_skew_ms integer,
       sample_origin text, thorchain_height bigint, pool_price_method text,
       oracle_price_method text, binance_price_method text
     )
     on conflict (observed_at, asset)
     do update set
       symbol = excluded.symbol,
       chain = excluded.chain,
       pool_status = excluded.pool_status,
       pool_price_usd = excluded.pool_price_usd,
       pool_balance_asset = excluded.pool_balance_asset,
       pool_balance_rune = excluded.pool_balance_rune,
       oracle_symbol = excluded.oracle_symbol,
       oracle_price_usd = excluded.oracle_price_usd,
       oracle_observed_at = excluded.oracle_observed_at,
       binance_symbol = excluded.binance_symbol,
       binance_bid_usd = excluded.binance_bid_usd,
       binance_ask_usd = excluded.binance_ask_usd,
       binance_price_usd = excluded.binance_price_usd,
       binance_observed_at = excluded.binance_observed_at,
       source_skew_ms = excluded.source_skew_ms,
       sample_origin = excluded.sample_origin,
       thorchain_height = excluded.thorchain_height,
       pool_price_method = excluded.pool_price_method,
       oracle_price_method = excluded.oracle_price_method,
       binance_price_method = excluded.binance_price_method,
       updated_at = now()
     where current.sample_origin <> 'scheduled'
        or excluded.sample_origin = 'scheduled'
        or (
          excluded.sample_origin = 'historical_backfill'
          and (
            current.pool_price_method = 'thornode-core-snapshot'
            or (current.oracle_symbol is not null and current.oracle_price_usd is null)
            or (current.binance_symbol is not null and current.binance_price_usd is null)
          )
        )`,
    [JSON.stringify(payload)]
  );
}

export async function persistPoolDislocationRows(client, rows = [], options = {}) {
  await client.query('begin');
  try {
    const result = await upsertPoolDislocationRows(client, rows);
    if (options.pruneBefore) {
      await client.query(
        `delete from pool_dislocation_observations
         where observed_at < $1::timestamptz - ($2::text || ' days')::interval`,
        [options.pruneBefore, options.retentionDays || POOL_DISLOCATION_RETENTION_DAYS]
      );
    }
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

export async function loadPoolDislocationWindow(client, asOf) {
  const { rows } = await client.query(
    `select observed_at, asset, symbol, chain, pool_status,
            pool_price_usd, oracle_symbol, oracle_price_usd,
            binance_symbol, binance_price_usd,
            sample_origin, thorchain_height, pool_price_method,
            oracle_price_method, binance_price_method
     from pool_dislocation_observations
     where observed_at between $1::timestamptz - interval '7 days' and $1::timestamptz
     order by asset, observed_at`,
    [asOf]
  );
  return rows;
}
