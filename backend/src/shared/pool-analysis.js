import { getReadModel } from './read-models.js';
import {
  coreSnapshotValue,
  getThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from './thornode-core-snapshot.js';
import { normalizeOraclePrices, referenceMappingForAsset } from './pool-dislocation.js';
import {
  loadPoolAnalysisAggregates,
  loadPoolAnalysisSyncStates
} from './pool-analysis-store.js';

export const POOL_ANALYSIS_MODEL_KEY = 'pool-analysis:v1';
export const POOL_ANALYSIS_SCHEMA_VERSION = 1;
export const POOL_ANALYSIS_TTL_MS = 20 * 60 * 1000;
export const POOL_ANALYSIS_PERIOD_DAYS = 30;
export const POOL_ANALYSIS_TABLE_PERIODS = Object.freeze([
  Object.freeze({ id: '24h', label: '24H', days: 1 }),
  Object.freeze({ id: '7d', label: '7D', days: 7 }),
  Object.freeze({ id: '30d', label: '30D', days: 30 }),
  Object.freeze({ id: '90d', label: '90D', days: 90 }),
  Object.freeze({ id: '1y', label: '1Y', days: 365 })
]);
export const POOL_ANALYSIS_START_DATE = '2021-04-01';

const DAY_MS = 24 * 60 * 60 * 1000;
const INTEGER = /^\d+$/;

export function nonNegativeBaseString(value, fallback = null) {
  const normalized = String(value ?? '').trim();
  return INTEGER.test(normalized) ? BigInt(normalized).toString() : fallback;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positive(value) {
  const numeric = finite(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function dayString(value) {
  const normalized = value instanceof Date
    ? (Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10))
    : String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function dayFromUnix(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? new Date(seconds * 1000).toISOString().slice(0, 10)
    : '';
}

function isoFromUnix(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function decimal(value) {
  const numeric = finite(value);
  return numeric !== null && numeric >= 0 ? String(value) : null;
}

export function assetIdentity(value) {
  const asset = String(value || '').trim().toUpperCase();
  const separator = asset.indexOf('.');
  const chain = separator > 0 ? asset.slice(0, separator) : '';
  const symbol = separator > 0 ? asset.slice(separator + 1).split('-')[0] : asset;
  return { asset, chain, symbol };
}

export function parsePoolAnalysisSwapInterval(interval = {}, options = {}) {
  const asset = assetIdentity(options.asset).asset;
  const day = options.day || dayFromUnix(interval.startTime ?? interval.start_time);
  if (!asset || !day) throw new Error('Pool swap interval requires an asset and UTC day');
  return {
    asset,
    day,
    volume_rune_e8: nonNegativeBaseString(interval.totalVolume ?? interval.total_volume, null),
    volume_usd_e2: nonNegativeBaseString(interval.totalVolumeUSD ?? interval.total_volume_usd, null),
    fees_rune_e8: nonNegativeBaseString(interval.totalFees ?? interval.total_fees, null),
    pool_earnings_rune_e8: null,
    rune_price_usd: decimal(interval.runePriceUSD ?? interval.rune_price_usd),
    interval_start: isoFromUnix(interval.startTime ?? interval.start_time),
    interval_end: isoFromUnix(interval.endTime ?? interval.end_time),
    partial: Boolean(options.partial),
    source: options.source || 'liquify-midgard-swaps'
  };
}

export function parsePoolAnalysisEarningsIntervals(intervals = [], options = {}) {
  const rows = [];
  const currentDay = dayString(options.currentDay);
  for (const interval of Array.isArray(intervals) ? intervals : []) {
    const day = dayFromUnix(interval?.startTime ?? interval?.start_time);
    if (!day) continue;
    for (const pool of Array.isArray(interval?.pools) ? interval.pools : []) {
      const asset = assetIdentity(pool?.pool ?? pool?.asset).asset;
      const earnings = nonNegativeBaseString(pool?.earnings, null);
      if (!asset || earnings === null) continue;
      rows.push({
        asset,
        day,
        volume_rune_e8: null,
        volume_usd_e2: null,
        fees_rune_e8: null,
        pool_earnings_rune_e8: earnings,
        rune_price_usd: decimal(interval?.runePriceUSD ?? interval?.rune_price_usd),
        interval_start: isoFromUnix(interval?.startTime ?? interval?.start_time),
        interval_end: isoFromUnix(interval?.endTime ?? interval?.end_time),
        partial: day === currentDay,
        source: 'liquify-midgard-earnings'
      });
    }
  }
  return rows;
}

function mergeHistoryRows(rows = []) {
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.asset}|${row.day}`;
    const prior = merged.get(key) || {};
    merged.set(key, {
      ...prior,
      ...row,
      volume_rune_e8: row.volume_rune_e8 ?? prior.volume_rune_e8 ?? null,
      volume_usd_e2: row.volume_usd_e2 ?? prior.volume_usd_e2 ?? null,
      fees_rune_e8: row.fees_rune_e8 ?? prior.fees_rune_e8 ?? null,
      pool_earnings_rune_e8: row.pool_earnings_rune_e8 ?? prior.pool_earnings_rune_e8 ?? null,
      rune_price_usd: row.rune_price_usd ?? prior.rune_price_usd ?? null,
      interval_start: row.interval_start ?? prior.interval_start ?? null,
      interval_end: row.interval_end ?? prior.interval_end ?? null,
      partial: Boolean(row.partial || prior.partial),
      source: prior.source && prior.source !== row.source
        ? 'liquify-midgard-history'
        : row.source || prior.source
    });
  }
  return [...merged.values()].sort((left, right) => (
    left.asset.localeCompare(right.asset) || left.day.localeCompare(right.day)
  ));
}

export { mergeHistoryRows as mergePoolAnalysisHistoryRows };

function divideBase(numerator, denominator, multiplier = 1) {
  const top = positive(numerator);
  const bottom = positive(denominator);
  return top === null || bottom === null ? null : (top / bottom) * multiplier;
}

function annualize(value, coveredDays, periodDays = POOL_ANALYSIS_PERIOD_DAYS) {
  const numeric = finite(value);
  return numeric === null || coveredDays < Math.ceil(periodDays * 0.9)
    ? null
    : numeric * (365 / periodDays);
}

function sourceTime(...values) {
  const timestamps = values.map((value) => Date.parse(String(value || ''))).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

export function buildPoolAnalysisRows({ pools = [], oraclePayload = {}, aggregates = [] } = {}) {
  const aggregatesByAsset = new Map();
  for (const aggregate of aggregates) {
    const asset = assetIdentity(aggregate.asset).asset;
    const periodId = String(aggregate.period_id || '30d').toLowerCase();
    if (!asset) continue;
    if (!aggregatesByAsset.has(asset)) aggregatesByAsset.set(asset, new Map());
    aggregatesByAsset.get(asset).set(periodId, aggregate);
  }
  const oracles = normalizeOraclePrices(oraclePayload);
  const runePriceUsd = positive(oracles.get('RUNE'));

  return (Array.isArray(pools) ? pools : [])
    .filter((pool) => ['available', 'staged'].includes(String(pool?.status || '').toLowerCase()))
    .map((pool) => {
      const identity = assetIdentity(pool.asset);
      const assetAggregates = aggregatesByAsset.get(identity.asset) || new Map();
      const balanceRune = nonNegativeBaseString(pool.balance_rune, null);
      const balanceAsset = nonNegativeBaseString(pool.balance_asset, null);
      const volume24hRune = nonNegativeBaseString(pool.volume_rune, null);
      const poolPriceUsd = positive(pool.asset_tor_price) === null
        ? null
        : Number(pool.asset_tor_price) / 1e8;
      const oracleSymbol = referenceMappingForAsset(identity.asset).oracle;
      const oraclePriceUsd = oracleSymbol ? positive(oracles.get(oracleSymbol)) : null;
      const periodMetrics = Object.fromEntries(POOL_ANALYSIS_TABLE_PERIODS.map((period) => {
        const aggregate = assetAggregates.get(period.id) || {};
        const volumeRune = nonNegativeBaseString(aggregate.volume_rune_e8, null);
        const feesRune = nonNegativeBaseString(aggregate.fees_rune_e8, null);
        const coveredDays = Math.max(0, Number(aggregate.observed_days) || 0);
        const annualizedFeesRune = annualize(
          feesRune === null ? null : Number(feesRune) / 1e8,
          coveredDays,
          period.days
        );
        return [period.id, {
          id: period.id,
          days: period.days,
          volume_rune_e8: volumeRune,
          volume_usd: finite(aggregate.volume_usd),
          fees_rune_e8: feesRune,
          fees_usd: finite(aggregate.fees_usd),
          fee_volume_percent: divideBase(feesRune, volumeRune, 100),
          volume_depth_percent: coveredDays > 0
            ? divideBase(volumeRune, balanceRune, 100 / coveredDays)
            : null,
          annualized_fees_rune: annualizedFeesRune,
          annualized_fees_usd: annualize(aggregate.fees_usd, coveredDays, period.days),
          annualized_fee_return_percent: annualizedFeesRune === null || balanceRune === null
            ? null
            : divideBase(annualizedFeesRune, (Number(balanceRune) / 1e8) * 2, 100),
          coverage: {
            first_day: dayString(aggregate.first_day),
            last_day: dayString(aggregate.last_day),
            observed_days: coveredDays,
            expected_days: period.days,
            missing_days: Math.max(0, period.days - coveredDays)
          }
        }];
      }));
      const defaultAggregate = assetAggregates.get('30d') || {};
      const defaultMetrics = periodMetrics['30d'];
      const defaultPoolEarningsRune = nonNegativeBaseString(defaultAggregate.pool_earnings_rune_e8, null);
      const defaultPoolEarningsUsd = finite(defaultAggregate.pool_earnings_usd);
      return {
        asset: identity.asset,
        chain: identity.chain,
        symbol: identity.symbol,
        status: String(pool.status || ''),
        trading_halted: Boolean(pool.trading_halted),
        price_usd: poolPriceUsd,
        oracle_symbol: oracleSymbol,
        oracle_price_usd: oraclePriceUsd,
        oracle_deviation_percent: poolPriceUsd && oraclePriceUsd
          ? ((poolPriceUsd / oraclePriceUsd) - 1) * 100
          : null,
        depth_usd: balanceRune && runePriceUsd
          ? (Number(balanceRune) / 1e8) * runePriceUsd
          : null,
        balance_asset_e8: balanceAsset,
        balance_rune_e8: balanceRune,
        volume_24h_rune_e8: volume24hRune,
        volume_24h_usd: volume24hRune && runePriceUsd
          ? (Number(volume24hRune) / 1e8) * runePriceUsd
          : null,
        period_volume_rune_e8: defaultMetrics.volume_rune_e8,
        period_volume_usd: defaultMetrics.volume_usd,
        period_fees_rune_e8: defaultMetrics.fees_rune_e8,
        period_fees_usd: defaultMetrics.fees_usd,
        fee_volume_percent: defaultMetrics.fee_volume_percent,
        volume_depth_percent: divideBase(volume24hRune, balanceRune, 100),
        annualized_pool_earnings_rune: annualize(
          defaultPoolEarningsRune === null ? null : Number(defaultPoolEarningsRune) / 1e8,
          defaultMetrics.coverage.observed_days
        ),
        annualized_pool_earnings_usd: annualize(
          defaultPoolEarningsUsd,
          defaultMetrics.coverage.observed_days
        ),
        annualized_fees_rune: defaultMetrics.annualized_fees_rune,
        annualized_fees_usd: defaultMetrics.annualized_fees_usd,
        annualized_fee_return_percent: defaultMetrics.annualized_fee_return_percent,
        coverage: defaultMetrics.coverage,
        period_metrics: periodMetrics
      };
    })
    .sort((left, right) => (right.depth_usd ?? -1) - (left.depth_usd ?? -1));
}

export async function buildPoolAnalysisReadModel(client, options = {}) {
  const nowValue = typeof options.now === 'function' ? options.now() : options.now;
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  const completedDay = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1
  )).toISOString().slice(0, 10);
  const [core, aggregates, syncStates] = await Promise.all([
    (options.getCoreSnapshot || getThorNodeCoreSnapshot)({ client, allowStale: true }),
    (options.loadAggregates || loadPoolAnalysisAggregates)(
      client,
      completedDay,
      POOL_ANALYSIS_TABLE_PERIODS
    ),
    (options.loadSyncStates || loadPoolAnalysisSyncStates)(client)
  ]);
  const pools = coreSnapshotValue(core, 'pools', []);
  const oraclePayload = coreSnapshotValue(core, 'oracle_prices', {});
  const rows = buildPoolAnalysisRows({ pools, oraclePayload, aggregates });
  if (!rows.length) throw new Error('Pool Analysis found no Available or Staged pools');
  const warnings = [];
  if (isThorNodeCoreSnapshotStale(core, ['pools', 'oracle_prices'])) {
    warnings.push('Current THORNode pool or oracle state is stale');
  }
  const syncErrors = syncStates.filter((row) => row.last_error);
  if (syncErrors.length) warnings.push(`${syncErrors.length} pool history sync(s) reported an error`);
  const incomplete = rows.filter((row) => (
    row.period_metrics['30d'].coverage.observed_days < POOL_ANALYSIS_PERIOD_DAYS
  )).length;
  if (incomplete) warnings.push(`${incomplete} pool(s) have incomplete 30-day history coverage`);
  const generatedAt = now.toISOString();
  const sourceUpdatedAt = sourceTime(
    core?.sourceUpdatedAt,
    core?.payload?.source_updated_at,
    ...aggregates.map((row) => row.source_updated_at),
    ...syncStates.map((row) => row.updated_at)
  );
  return {
    payload: {
      schema_version: POOL_ANALYSIS_SCHEMA_VERSION,
      as_of: generatedAt,
      period: {
        id: '30d',
        days: POOL_ANALYSIS_PERIOD_DAYS,
        through_day: completedDay,
        available: POOL_ANALYSIS_TABLE_PERIODS
      },
      rune_price_usd: positive(normalizeOraclePrices(oraclePayload).get('RUNE')),
      pools: rows,
      sources: {
        current: 'thornode-core:pools+oracle_prices',
        history: 'liquify-midgard:history/swaps+history/earnings'
      },
      warnings
    },
    generatedAt,
    sourceUpdatedAt,
    metadata: { partial: warnings.length > 0, warnings },
    stats: { pools: rows.length, incomplete_pools: incomplete, sync_errors: syncErrors.length }
  };
}

export function buildPoolAnalysisSeries(rows = [], options = {}) {
  const range = options.range === 'all' ? 'all' : '30d';
  const asOfDay = dayString(options.asOf) || new Date().toISOString().slice(0, 10);
  const cutoffMs = Date.parse(`${asOfDay}T00:00:00Z`) - ((POOL_ANALYSIS_PERIOD_DAYS - 1) * DAY_MS);
  let cumulativeFees = 0n;
  let cumulativeFeesUsd = 0;
  let usdComplete = true;
  const normalized = [...rows]
    .sort((left, right) => dayString(left.day).localeCompare(dayString(right.day)))
    .map((row) => {
      const day = dayString(row.day);
      const feesBase = nonNegativeBaseString(row.fees_rune_e8, null);
      const volumeBase = nonNegativeBaseString(row.volume_rune_e8, null);
      const volumeUsdCents = nonNegativeBaseString(row.volume_usd_e2, null);
      const runePrice = finite(row.rune_price_usd);
      if (feesBase !== null) cumulativeFees += BigInt(feesBase);
      const feeRune = feesBase === null ? null : Number(feesBase) / 1e8;
      const feeUsd = feeRune === null || runePrice === null ? null : feeRune * runePrice;
      if (feesBase !== null && BigInt(feesBase) > 0n && feeUsd === null) usdComplete = false;
      if (feeUsd !== null) cumulativeFeesUsd += feeUsd;
      return {
        day,
        volume_rune_e8: volumeBase,
        volume_usd: volumeUsdCents === null ? null : Number(volumeUsdCents) / 100,
        fees_rune_e8: feesBase,
        fees_usd: feeUsd,
        cumulative_fees_rune_e8: cumulativeFees.toString(),
        cumulative_fees_usd: usdComplete ? cumulativeFeesUsd : null,
        rune_price_usd: runePrice,
        partial: Boolean(row.partial),
        source: String(row.source || '')
      };
    });
  const selectedObserved = range === 'all'
    ? normalized
    : normalized.filter((row) => Date.parse(`${row.day}T00:00:00Z`) >= cutoffMs);
  const missingDays = [];
  const selected = [];
  for (let index = 0; index < selectedObserved.length; index += 1) {
    const row = selectedObserved[index];
    if (index > 0) {
      let cursor = Date.parse(`${selectedObserved[index - 1].day}T00:00:00Z`) + DAY_MS;
      const end = Date.parse(`${row.day}T00:00:00Z`);
      while (cursor < end && missingDays.length < 3660) {
        const missingDay = new Date(cursor).toISOString().slice(0, 10);
        missingDays.push(missingDay);
        selected.push({
          day: missingDay,
          volume_rune_e8: null,
          volume_usd: null,
          fees_rune_e8: null,
          fees_usd: null,
          cumulative_fees_rune_e8: null,
          cumulative_fees_usd: null,
          rune_price_usd: null,
          partial: false,
          source: 'missing'
        });
        cursor += DAY_MS;
      }
    }
    selected.push(row);
  }
  return {
    range,
    points: selected,
    coverage: {
      first_indexed_day: normalized[0]?.day || '',
      first_displayed_day: selected[0]?.day || '',
      last_day: selected.at(-1)?.day || '',
      observed_days: selectedObserved.length,
      missing_days: missingDays
    }
  };
}

export async function getPoolAnalysisReadModel(options = {}) {
  return getReadModel(POOL_ANALYSIS_MODEL_KEY, { ...options, allowStale: true });
}
