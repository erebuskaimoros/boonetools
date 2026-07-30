export const POOL_DISLOCATION_MODEL_KEY = 'pool-dislocation-summary:v1';
export const POOL_DISLOCATION_SCHEMA_VERSION = 3;
export const POOL_DISLOCATION_TTL_MS = 15 * 60 * 1000;
export const POOL_DISLOCATION_SAMPLE_MINUTES = 5;
export const POOL_DISLOCATION_WINDOW_DAYS = 7;
export const POOL_DISLOCATION_RETENTION_DAYS = 30;
export const POOL_DISLOCATION_MAX_SOURCE_SKEW_MS = 30_000;
export const POOL_DISLOCATION_THRESHOLDS = Object.freeze([0.5, 1, 2]);

const FIVE_MINUTES_MS = POOL_DISLOCATION_SAMPLE_MINUTES * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WINDOWS = Object.freeze([
  ['1h', HOUR_MS],
  ['4h', 4 * HOUR_MS],
  ['1d', 24 * HOUR_MS],
  ['3d', 3 * 24 * HOUR_MS],
  ['7d', 7 * 24 * HOUR_MS]
]);

// Cross-chain and contract assets are deliberately mapped by exact asset id.
// Binance references must be directly traded spot assets; do not substitute an
// underlying asset for a wrapped or pegged pool asset.
// A new THORChain pool still appears in the dashboard, but has null references
// until this table is reviewed and extended.
export const POOL_REFERENCE_MAPPINGS = Object.freeze({
  'AVAX.AVAX': { oracle: 'AVAX', binance: 'AVAXUSDT' },
  'AVAX.SOL-0XFE6B19286885A4F7F55ADAD09C3CD1F906D2478F': { oracle: 'SOL', binance: null },
  'AVAX.USDC-0XB97EF9EF8734C71904D8002F8B6BC66DD9C48A6E': { oracle: 'USDC', binance: 'USDCUSDT' },
  'AVAX.USDT-0X9702230A8EA53601F5CD2DC00FDBC13D4DF4A8C7': { oracle: 'USDT', binance: null },
  'BASE.ETH': { oracle: 'ETH', binance: 'ETHUSDT' },
  'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913': { oracle: 'USDC', binance: 'USDCUSDT' },
  'BCH.BCH': { oracle: 'BCH', binance: 'BCHUSDT' },
  'BSC.BNB': { oracle: 'BNB', binance: 'BNBUSDT' },
  'BSC.BTCB-0X7130D2A12B9BCBFAE4F2634D864A1EE1CE3EAD9C': { oracle: 'BTC', binance: null },
  'BSC.ETH-0X2170ED0880AC9A755FD29B2688956BD959F933F8': { oracle: 'ETH', binance: null },
  'BSC.TWT-0X4B0F1812E5DF2A09796481FF14017E6005508003': { oracle: null, binance: 'TWTUSDT' },
  'BSC.USDC-0X8AC76A51CC950D9822D68B83FE1AD97B32CD580D': { oracle: 'USDC', binance: null },
  'BSC.USDT-0X55D398326F99059FF775485246999027B3197955': { oracle: 'USDT', binance: null },
  'BTC.BTC': { oracle: 'BTC', binance: 'BTCUSDT' },
  'DOGE.DOGE': { oracle: 'DOGE', binance: 'DOGEUSDT' },
  'ETH.AAVE-0X7FC66500C84A76AD7E9C93437BFC5AC33E2DDAE9': { oracle: null, binance: 'AAVEUSDT' },
  'ETH.ETH': { oracle: 'ETH', binance: 'ETHUSDT' },
  'ETH.LINK-0X514910771AF9CA656AF840DFF83E8264ECF986CA': { oracle: null, binance: 'LINKUSDT' },
  'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48': { oracle: 'USDC', binance: 'USDCUSDT' },
  'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7': { oracle: 'USDT', binance: null },
  'ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599': { oracle: 'BTC', binance: 'WBTCUSDT' },
  'ETH.YFI-0X0BC529C00C6401AEF6D220BE8C6EA1667F6AD93E': { oracle: null, binance: 'YFIUSDT' },
  'GAIA.ATOM': { oracle: 'ATOM', binance: 'ATOMUSDT' },
  'LTC.LTC': { oracle: 'LTC', binance: 'LTCUSDT' },
  'SOL.SOL': { oracle: 'SOL', binance: 'SOLUSDT' },
  'TRON.TRX': { oracle: 'TRX', binance: 'TRXUSDT' },
  'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T': { oracle: 'USDT', binance: null },
  'XRP.XRP': { oracle: 'XRP', binance: 'XRPUSDT' },
  'ZEC.ZEC': { oracle: 'ZEC', binance: 'ZECUSDT' }
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function assetParts(asset) {
  const normalized = String(asset || '').trim().toUpperCase();
  const separator = normalized.indexOf('.');
  const chain = separator > 0 ? normalized.slice(0, separator) : '';
  const ticker = separator > 0 ? normalized.slice(separator + 1).split('-')[0] : normalized;
  return { asset: normalized, chain, symbol: ticker };
}

function enabledFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

export function normalizeChainTradingStatus(inboundAddresses = []) {
  const rows = Array.isArray(inboundAddresses) ? inboundAddresses : [];
  const globalTradingPaused = rows.some((row) => enabledFlag(row?.global_trading_paused));
  const chains = {};

  for (const row of rows) {
    const chain = String(row?.chain || '').trim().toUpperCase();
    if (!chain) continue;
    const halted = enabledFlag(row?.halted);
    const chainTradingPaused = enabledFlag(row?.chain_trading_paused);
    const prior = chains[chain];
    chains[chain] = {
      trading_halted: Boolean(
        prior?.trading_halted || globalTradingPaused || halted || chainTradingPaused
      ),
      halted: Boolean(prior?.halted || halted),
      global_trading_paused: Boolean(prior?.global_trading_paused || globalTradingPaused),
      chain_trading_paused: Boolean(prior?.chain_trading_paused || chainTradingPaused)
    };
  }

  const knownChains = Object.keys(chains).sort();
  return {
    known_chains: knownChains,
    halted_chains: knownChains.filter((chain) => chains[chain].trading_halted),
    chains: Object.fromEntries(knownChains.map((chain) => [chain, chains[chain]]))
  };
}

export function referenceMappingForAsset(asset) {
  const key = String(asset || '').trim().toUpperCase();
  const mapping = POOL_REFERENCE_MAPPINGS[key];
  return mapping ? { ...mapping } : { oracle: null, binance: null };
}

export function binanceSymbolsForPools(pools = []) {
  return [...new Set(pools
    .map((pool) => referenceMappingForAsset(pool?.asset).binance)
    .filter(Boolean))]
    .sort();
}

export function floorToFiveMinuteBucket(value = new Date()) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error('Invalid observation timestamp');
  return new Date(Math.floor(timestamp / FIVE_MINUTES_MS) * FIVE_MINUTES_MS).toISOString();
}

export function computeDislocationPercent(poolPrice, referencePrice) {
  const pool = finiteNumber(poolPrice);
  const reference = finiteNumber(referencePrice);
  if (pool === null || reference === null || pool <= 0 || reference <= 0) return null;
  return ((pool / reference) - 1) * 100;
}

export function normalizeOraclePrices(payload) {
  const rows = Array.isArray(payload?.prices) ? payload.prices : [];
  return new Map(rows.flatMap((row) => {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const price = finiteNumber(row?.price);
    return symbol && price !== null && price > 0 ? [[symbol, price]] : [];
  }));
}

export function normalizeBinanceBookTickers(payload) {
  const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
  return new Map(rows.flatMap((row) => {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const bid = finiteNumber(row?.bidPrice);
    const ask = finiteNumber(row?.askPrice);
    if (!symbol || bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) return [];
    return [[symbol, { bid, ask, mid: (bid + ask) / 2 }]];
  }));
}

export function buildObservationRows({
  pools = [],
  oraclePrices = new Map(),
  binanceTickers = new Map(),
  observedAt,
  poolObservedAt,
  oracleObservedAt = null,
  binanceObservedAt = null,
  sampleOrigin = 'scheduled',
  thorchainHeight = null,
  poolPriceMethod = 'thornode-asset-tor',
  oraclePriceMethod = 'thornode-oracle',
  binancePriceMethod = 'book-ticker-mid'
} = {}) {
  const bucket = floorToFiveMinuteBucket(observedAt);
  const poolTime = isoTimestamp(poolObservedAt);
  const oracleTime = isoTimestamp(oracleObservedAt);
  const binanceTime = isoTimestamp(binanceObservedAt);

  return pools
    .filter((pool) => String(pool?.status || '').toLowerCase() === 'available')
    .map((pool) => {
      const identity = assetParts(pool.asset);
      const mapping = referenceMappingForAsset(identity.asset);
      const poolPrice = finiteNumber(pool.asset_tor_price);
      const normalizedPoolPrice = poolPrice !== null && poolPrice > 0 ? poolPrice / 1e8 : null;
      const oraclePrice = mapping.oracle && oracleTime ? oraclePrices.get(mapping.oracle) ?? null : null;
      const binance = mapping.binance && binanceTime ? binanceTickers.get(mapping.binance) ?? null : null;
      const sourceTimes = [poolTime, oraclePrice !== null ? oracleTime : null, binance ? binanceTime : null]
        .filter(Boolean)
        .map(Date.parse)
        .filter(Number.isFinite);
      const sourceSkewMs = sourceTimes.length > 1 ? Math.max(...sourceTimes) - Math.min(...sourceTimes) : null;
      const poolTimestamp = Date.parse(poolTime || '');
      const oracleTimestamp = Date.parse(oracleTime || '');
      const binanceTimestamp = Date.parse(binanceTime || '');
      const oracleAligned = oraclePrice !== null
        && Number.isFinite(poolTimestamp)
        && Number.isFinite(oracleTimestamp)
        && Math.abs(oracleTimestamp - poolTimestamp) <= POOL_DISLOCATION_MAX_SOURCE_SKEW_MS;
      const binanceAligned = Boolean(binance)
        && Number.isFinite(poolTimestamp)
        && Number.isFinite(binanceTimestamp)
        && Math.abs(binanceTimestamp - poolTimestamp) <= POOL_DISLOCATION_MAX_SOURCE_SKEW_MS;

      return {
        observedAt: bucket,
        asset: identity.asset,
        symbol: identity.symbol,
        chain: identity.chain,
        poolStatus: String(pool.status),
        poolPriceUsd: normalizedPoolPrice,
        poolBalanceAsset: String(pool.balance_asset ?? ''),
        poolBalanceRune: String(pool.balance_rune ?? ''),
        oracleSymbol: mapping.oracle,
        oraclePriceUsd: oracleAligned ? oraclePrice : null,
        oracleObservedAt: oracleAligned ? oracleTime : null,
        binanceSymbol: mapping.binance,
        binanceBidUsd: binanceAligned ? binance?.bid ?? null : null,
        binanceAskUsd: binanceAligned ? binance?.ask ?? null : null,
        binancePriceUsd: binanceAligned ? binance?.mid ?? null : null,
        binanceObservedAt: binanceAligned ? binanceTime : null,
        sourceSkewMs,
        sampleOrigin,
        thorchainHeight,
        poolPriceMethod,
        oraclePriceMethod: oracleAligned ? oraclePriceMethod : null,
        binancePriceMethod: binanceAligned ? binancePriceMethod : null
      };
    })
    .sort((left, right) => left.asset.localeCompare(right.asset));
}

function rowPoint(row) {
  const poolPrice = finiteNumber(row.pool_price_usd ?? row.poolPriceUsd);
  const oraclePrice = finiteNumber(row.oracle_price_usd ?? row.oraclePriceUsd);
  const binancePrice = finiteNumber(row.binance_price_usd ?? row.binancePriceUsd);
  return {
    observed_at: isoTimestamp(row.observed_at ?? row.observedAt),
    pool_price_usd: poolPrice,
    oracle_price_usd: oraclePrice,
    binance_price_usd: binancePrice,
    oracle_dislocation: computeDislocationPercent(poolPrice, oraclePrice),
    binance_dislocation: computeDislocationPercent(poolPrice, binancePrice),
    sample_origin: String(row.sample_origin ?? row.sampleOrigin ?? 'scheduled'),
    thorchain_height: finiteNumber(row.thorchain_height ?? row.thorchainHeight),
    pool_price_method: row.pool_price_method ?? row.poolPriceMethod ?? null,
    oracle_price_method: row.oracle_price_method ?? row.oraclePriceMethod ?? null,
    binance_price_method: row.binance_price_method ?? row.binancePriceMethod ?? null
  };
}

function summarizeProvenance(points = []) {
  const origins = points.map((point) => String(point?.sample_origin || 'scheduled'));
  const methods = (field) => [...new Set(points.map((point) => point?.[field]).filter(Boolean))].sort();
  return {
    scheduled_samples: origins.filter((origin) => origin === 'scheduled').length,
    backfilled_samples: origins.filter((origin) => origin === 'historical_backfill').length,
    pool_price_methods: methods('pool_price_method'),
    oracle_price_methods: methods('oracle_price_method'),
    binance_price_methods: methods('binance_price_method')
  };
}

function pointMagnitude(point) {
  const values = [point.oracle_dislocation, point.binance_dislocation]
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values.map(Math.abs)) : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function compactHourly(points) {
  const buckets = new Map();
  for (const point of points) {
    const timestamp = Date.parse(point.observed_at || '');
    const magnitude = pointMagnitude(point);
    if (!Number.isFinite(timestamp) || magnitude === null) continue;
    const bucket = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
    const current = buckets.get(bucket);
    if (!current || magnitude > current.magnitude) buckets.set(bucket, { point, magnitude });
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => ({
      observed_at: value.point.observed_at,
      oracle_dislocation: value.point.oracle_dislocation,
      binance_dislocation: value.point.binance_dislocation,
      max_abs: value.magnitude
    }));
}

function summarizeRows(rows, asOf) {
  const newest = rows.at(-1) || {};
  const points = rows.map(rowPoint);
  const asOfMs = Date.parse(asOf);
  const magnitudes = points.map(pointMagnitude);
  const validMagnitudes = magnitudes.filter((value) => value !== null);
  const averages = Object.fromEntries(WINDOWS.map(([key, duration]) => {
    const values = points
      .filter((point) => Date.parse(point.observed_at || '') >= asOfMs - duration)
      .map(pointMagnitude)
      .filter((value) => value !== null);
    return [key, average(values)];
  }));
  const latest = rowPoint(newest);
  const thresholdHours = Object.fromEntries(POOL_DISLOCATION_THRESHOLDS.map((threshold) => [
    String(threshold),
    validMagnitudes.filter((value) => value >= threshold).length * POOL_DISLOCATION_SAMPLE_MINUTES / 60
  ]));

  return {
    asset: String(newest.asset || ''),
    symbol: String(newest.symbol || assetParts(newest.asset).symbol),
    chain: String(newest.chain || assetParts(newest.asset).chain),
    status: String(newest.pool_status || ''),
    oracle_symbol: newest.oracle_symbol || null,
    binance_symbol: newest.binance_symbol || null,
    latest,
    average_abs: averages,
    peak_abs_7d: validMagnitudes.length ? Math.max(...validMagnitudes) : null,
    time_outside_hours: thresholdHours,
    samples: {
      total: points.length,
      oracle: points.filter((point) => point.oracle_dislocation !== null).length,
      binance: points.filter((point) => point.binance_dislocation !== null).length,
      scheduled: points.filter((point) => point.sample_origin === 'scheduled').length,
      backfilled: points.filter((point) => point.sample_origin === 'historical_backfill').length
    },
    provenance: summarizeProvenance(points),
    sparkline: compactHourly(points)
  };
}

export function buildPoolDislocationSummary(rows = [], options = {}) {
  const currentAssets = Array.isArray(options.currentAssets)
    ? new Set(options.currentAssets.map((asset) => String(asset || '').toUpperCase()).filter(Boolean))
    : null;
  const grouped = new Map();
  const includedRows = [];
  for (const row of rows) {
    const asset = String(row?.asset || '').toUpperCase();
    if (!asset) continue;
    if (currentAssets && !currentAssets.has(asset)) continue;
    includedRows.push(row);
    if (!grouped.has(asset)) grouped.set(asset, []);
    grouped.get(asset).push(row);
  }
  for (const group of grouped.values()) {
    group.sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at));
  }
  const latestTimestamp = [...grouped.values()]
    .flatMap((group) => group.at(-1)?.observed_at || [])
    .map((value) => isoTimestamp(value))
    .filter(Boolean)
    .sort()
    .at(-1);
  const asOf = isoTimestamp(options.asOf) || latestTimestamp || new Date().toISOString();
  const chainTrading = options.chainTrading?.chains
    ? options.chainTrading
    : normalizeChainTradingStatus();
  const pools = [...grouped.values()]
    .map((group) => {
      const pool = summarizeRows(group, asOf);
      const trading = chainTrading.chains?.[pool.chain];
      return {
        ...pool,
        trading_halted: Boolean(trading?.trading_halted),
        trading_status_known: Boolean(trading)
      };
    })
    .sort((left, right) => left.asset.localeCompare(right.asset));

  return {
    schema_version: POOL_DISLOCATION_SCHEMA_VERSION,
    as_of: asOf,
    window: '7d',
    interval: '5m',
    interval_minutes: POOL_DISLOCATION_SAMPLE_MINUTES,
    expected_samples: (POOL_DISLOCATION_WINDOW_DAYS * 24 * 60 / POOL_DISLOCATION_SAMPLE_MINUTES) + 1,
    thresholds: [...POOL_DISLOCATION_THRESHOLDS],
    sources: options.sources || {},
    chain_trading: chainTrading,
    coverage: {
      total_pools: pools.length,
      oracle_mapped: pools.filter((pool) => pool.oracle_symbol).length,
      binance_mapped: pools.filter((pool) => pool.binance_symbol).length,
      fully_mapped: pools.filter((pool) => pool.oracle_symbol && pool.binance_symbol).length,
      fully_observed: pools.filter((pool) => (
        pool.latest.oracle_dislocation !== null && pool.latest.binance_dislocation !== null
      )).length
    },
    provenance: {
      scheduled_observations: includedRows.filter((row) => String(row?.sample_origin || 'scheduled') === 'scheduled').length,
      backfilled_observations: includedRows.filter((row) => row?.sample_origin === 'historical_backfill').length,
      pool_price_methods: [...new Set(includedRows.map((row) => row?.pool_price_method).filter(Boolean))].sort(),
      oracle_price_methods: [...new Set(includedRows.map((row) => row?.oracle_price_method).filter(Boolean))].sort(),
      binance_price_methods: [...new Set(includedRows.map((row) => row?.binance_price_method).filter(Boolean))].sort()
    },
    pools,
    warnings: options.warnings || []
  };
}

export function buildPoolDislocationSeries(rows = [], options = {}) {
  const first = rows[0] || {};
  const points = rows.map(rowPoint);
  return {
    schema_version: POOL_DISLOCATION_SCHEMA_VERSION,
    as_of: isoTimestamp(options.asOf) || isoTimestamp(rows.at(-1)?.observed_at) || new Date().toISOString(),
    window: '7d',
    interval: '5m',
    interval_minutes: POOL_DISLOCATION_SAMPLE_MINUTES,
    expected_samples: (POOL_DISLOCATION_WINDOW_DAYS * 24 * 60 / POOL_DISLOCATION_SAMPLE_MINUTES) + 1,
    asset: String(options.asset || first.asset || '').toUpperCase(),
    symbol: String(first.symbol || assetParts(options.asset || first.asset).symbol),
    chain: String(first.chain || assetParts(options.asset || first.asset).chain),
    oracle_symbol: first.oracle_symbol || null,
    binance_symbol: first.binance_symbol || null,
    provenance: summarizeProvenance(points),
    points
  };
}
