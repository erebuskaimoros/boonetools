import { config } from '../lib/config.js';
import { requestFromProviders } from '../lib/provider-client.js';
import {
  POOL_DISLOCATION_SAMPLE_MINUTES,
  POOL_DISLOCATION_WINDOW_DAYS,
  POOL_REFERENCE_MAPPINGS,
  buildObservationRows,
  floorToFiveMinuteBucket,
  normalizeOraclePrices
} from './pool-dislocation.js';
import { persistPoolDislocationRows } from './pool-dislocation-store.js';
import { fetchThorchainRpc } from './rpc.js';
import {
  loadThorchainMarketSnapshot,
  persistThorchainMarketSnapshot
} from './thorchain-market-snapshots.js';
import { fetchThorchain } from './thornode.js';

const FIVE_MINUTES_MS = POOL_DISLOCATION_SAMPLE_MINUTES * 60 * 1000;
const WINDOW_MS = POOL_DISLOCATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const BINANCE_KLINE_LIMIT = 1000;
const BINANCE_TIMEOUT_MS = 12_000;
const TRANSIENT_ERROR_PATTERN = /fetch failed|network|socket|timeout|timed out|aborted|cooling down|temporarily unavailable/i;

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid timestamp: ${value}`);
  return new Date(parsed).toISOString();
}

function timestampMilliseconds(value) {
  let parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > 100_000_000_000_000) parsed /= 1000;
  return parsed;
}

function sleep(delayMs) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

export function isTransientPoolDislocationBackfillError(error) {
  const status = Number(error?.status) || 0;
  if (error?.transient) return true;
  if (error?.name === 'ProviderCooldownError' || error?.name === 'AbortError') return true;
  if (status === 0 && TRANSIENT_ERROR_PATTERN.test(String(error?.message || ''))) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function retryPoolDislocationBackfillOperation(operation, options = {}) {
  const attempts = Math.max(1, finiteInteger(
    options.attempts ?? config.poolDislocationBackfillRetryAttempts
  ));
  const baseDelayMs = Math.max(0, finiteInteger(
    options.baseDelayMs ?? config.poolDislocationBackfillRetryBaseDelayMs
  ));
  const maxDelayMs = Math.max(baseDelayMs, finiteInteger(
    options.maxDelayMs ?? config.poolDislocationBackfillRetryMaxDelayMs
  ));
  const sleepFor = options.sleep || sleep;
  const now = options.now || Date.now;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransientPoolDislocationBackfillError(error)) throw error;
      const blockedUntilMs = Date.parse(String(error?.blockedUntil || ''));
      const cooldownDelayMs = Number.isFinite(blockedUntilMs)
        ? Math.max(0, blockedUntilMs - now() + 250)
        : 0;
      const exponentialDelayMs = baseDelayMs * (2 ** (attempt - 1));
      const delayMs = Math.min(maxDelayMs, Math.max(exponentialDelayMs, cooldownDelayMs));
      await options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        attempts,
        delayMs,
        error
      });
      await sleepFor(delayMs);
    }
  }
  throw new Error('Pool-dislocation backfill retry loop exhausted unexpectedly');
}

function progressLogger(event) {
  console.log(JSON.stringify({ type: 'pool_dislocation_backfill_progress', ...event }));
}

function configuredBinanceSymbols() {
  return [...new Set(Object.values(POOL_REFERENCE_MAPPINGS)
    .map((mapping) => mapping.binance)
    .filter(Boolean))].sort();
}

function configuredReferenceMappings() {
  return Object.entries(POOL_REFERENCE_MAPPINGS).map(([asset, mapping]) => ({
    asset,
    oracle_symbol: mapping.oracle,
    binance_symbol: mapping.binance
  }));
}

export function buildPoolDislocationBackfillBuckets(startAt, endAt) {
  const startMs = Date.parse(timestamp(startAt));
  const endMs = Date.parse(timestamp(endAt));
  if (startMs >= endMs) return [];
  if (startMs % FIVE_MINUTES_MS !== 0 || endMs % FIVE_MINUTES_MS !== 0) {
    throw new Error('Pool-dislocation backfill bounds must be exact five-minute UTC points');
  }
  const buckets = [];
  for (let value = startMs; value < endMs; value += FIVE_MINUTES_MS) {
    buckets.push(new Date(value).toISOString());
  }
  return buckets;
}

export function parsePoolDislocationRpcStatus(payload = {}) {
  if (payload.earliestHeight && payload.latestHeight) return payload;
  const info = payload?.result?.sync_info || {};
  const result = {
    earliestHeight: finiteInteger(info.earliest_block_height),
    earliestBlockTime: info.earliest_block_time ? timestamp(info.earliest_block_time) : null,
    latestHeight: finiteInteger(info.latest_block_height),
    latestBlockTime: info.latest_block_time ? timestamp(info.latest_block_time) : null
  };
  if (result.earliestHeight <= 0 || result.latestHeight <= result.earliestHeight || !result.latestBlockTime) {
    throw new Error('RPC status did not provide usable historical height bounds');
  }
  return result;
}

export function parsePoolDislocationRpcBlock(payload = {}) {
  if (payload.height && payload.blockTime) {
    return { height: finiteInteger(payload.height), blockTime: timestamp(payload.blockTime) };
  }
  const header = payload?.result?.block?.header || {};
  const result = {
    height: finiteInteger(header.height),
    blockTime: header.time ? timestamp(header.time) : null
  };
  if (result.height <= 0 || !result.blockTime) {
    throw new Error('RPC block response did not include a usable header');
  }
  return result;
}

export function poolDislocationHistoricalRpcUrls(options = {}) {
  return options.rpcUrls || [...config.rpcRestUrls, config.rpcArchiveRestUrl].filter(Boolean);
}

async function defaultFetchRpcStatus(options = {}) {
  return fetchThorchainRpc('/status', {}, {
    cooldownClient: options.client,
    cooldownScope: options.cooldownScope || 'market-snapshots',
    sharedCooldown: true,
    rpcUrls: poolDislocationHistoricalRpcUrls(options),
    timeoutMs: options.timeoutMs
  });
}

async function defaultFetchRpcBlock(height, options = {}) {
  return fetchThorchainRpc('/block', { height }, {
    cooldownClient: options.client,
    cooldownScope: options.cooldownScope || 'market-snapshots',
    sharedCooldown: true,
    rpcUrls: poolDislocationHistoricalRpcUrls(options),
    timeoutMs: options.timeoutMs
  });
}

export async function resolvePoolDislocationBlockAnchors(bucketTimes = [], options = {}) {
  if (!bucketTimes.length) return [];
  const delayMs = Math.max(0, finiteInteger(
    options.requestDelayMs ?? config.poolDislocationBackfillRequestDelayMs
  ));
  const fetchStatus = options.fetchStatus || defaultFetchRpcStatus;
  const fetchBlock = options.fetchBlock || defaultFetchRpcBlock;
  const status = parsePoolDislocationRpcStatus(await fetchStatus(options));
  const cache = new Map();
  const loadBlock = async (height) => {
    if (cache.has(height)) return cache.get(height);
    const block = parsePoolDislocationRpcBlock(await fetchBlock(height, options));
    if (block.height !== height) throw new Error(`RPC returned height ${block.height} for requested height ${height}`);
    cache.set(height, block);
    await sleep(delayMs);
    return block;
  };

  const earliest = status.earliestBlockTime
    ? { height: status.earliestHeight, blockTime: status.earliestBlockTime }
    : await loadBlock(status.earliestHeight);
  const latest = { height: status.latestHeight, blockTime: status.latestBlockTime };
  cache.set(earliest.height, earliest);
  cache.set(latest.height, latest);

  const anchors = [];
  let previous = earliest;
  for (const observedAt of bucketTimes.map(timestamp).sort()) {
    const targetMs = Date.parse(observedAt);
    if (options.skipPointsBeforeEarliest && targetMs < Date.parse(earliest.blockTime)) continue;
    if (options.skipPointsAtOrAfterLatest && targetMs >= Date.parse(latest.blockTime)) continue;
    if (Date.parse(previous.blockTime) > targetMs) previous = earliest;
    if (Date.parse(previous.blockTime) > targetMs || Date.parse(latest.blockTime) <= targetMs) {
      const error = new Error(`Backfill point ${observedAt} is outside RPC history bounds`);
      error.transient = true;
      throw error;
    }

    let low = previous;
    let high = latest;
    while (high.height - low.height > 1) {
      const lowMs = Date.parse(low.blockTime);
      const highMs = Date.parse(high.blockTime);
      const ratio = highMs > lowMs ? (targetMs - lowMs) / (highMs - lowMs) : 0.5;
      let guess = Math.floor(low.height + ((high.height - low.height) * Math.min(0.999999, Math.max(0.000001, ratio))));
      guess = Math.max(low.height + 1, Math.min(high.height - 1, guess));
      const candidate = await loadBlock(guess);
      if (Date.parse(candidate.blockTime) <= targetMs) low = candidate;
      else high = candidate;
    }

    anchors.push({ observedAt, height: low.height, blockTime: low.blockTime });
    previous = low;
  }
  return anchors;
}

export function normalizeBinanceKlineCloses(rows = []) {
  const closes = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const openMs = timestampMilliseconds(row[0]);
    const closePrice = Number(row[4]);
    if (!Number.isFinite(openMs) || !Number.isFinite(closePrice) || closePrice <= 0) continue;
    const boundaryMs = openMs + FIVE_MINUTES_MS;
    closes.set(new Date(boundaryMs).toISOString(), closePrice);
  }
  return closes;
}

export async function fetchBinanceKlineHistory(symbol, bucketTimes = [], options = {}) {
  if (!bucketTimes.length) return new Map();
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) throw new Error('Binance symbol is required');
  const sorted = bucketTimes.map(timestamp).sort();
  const firstBoundaryMs = Date.parse(sorted[0]);
  const lastBoundaryMs = Date.parse(sorted.at(-1));
  let cursor = firstBoundaryMs - FIVE_MINUTES_MS;
  const lastOpenMs = lastBoundaryMs - FIVE_MINUTES_MS;
  const rows = [];

  while (cursor <= lastOpenMs) {
    const path = `/api/v3/klines?symbol=${encodeURIComponent(normalizedSymbol)}`
      + `&interval=5m&startTime=${cursor}&endTime=${lastBoundaryMs - 1}&limit=${BINANCE_KLINE_LIMIT}`;
    const page = await (options.request || requestFromProviders)({
      bases: options.bases || config.binanceApiBaseUrls,
      path,
      timeoutMs: options.timeoutMs || BINANCE_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
      validateResponse: (payload) => Array.isArray(payload) ? null : 'Invalid Binance kline response',
      errorMessage: ({ status }) => `Binance kline request failed (${status})`
    });
    if (!page.length) break;
    rows.push(...page);
    const pageLastOpen = timestampMilliseconds(page.at(-1)?.[0]);
    if (!Number.isFinite(pageLastOpen) || pageLastOpen < cursor) {
      throw new Error(`Binance kline pagination stalled for ${normalizedSymbol}`);
    }
    cursor = pageLastOpen + FIVE_MINUTES_MS;
    if (page.length < BINANCE_KLINE_LIMIT) break;
  }
  return normalizeBinanceKlineCloses(rows);
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function loadBinanceBackfillHistory(bucketTimes, options = {}) {
  const symbols = options.binanceSymbols || configuredBinanceSymbols();
  const histories = await mapWithConcurrency(
    symbols,
    options.binanceConcurrency || 2,
    async (symbol) => [symbol, await (options.fetchBinanceHistory || fetchBinanceKlineHistory)(
      symbol,
      bucketTimes,
      options
    )]
  );
  return new Map(histories);
}

export async function fetchHistoricalPoolDislocationState(height, options = {}) {
  const fetchHistorical = options.fetchHistorical || ((path) => fetchThorchain(path, {
    bases: [
      config.poolDislocationThornodeUrls[0],
      config.thornodeArchiveUrl,
      ...config.poolDislocationThornodeUrls.slice(1)
    ].filter(Boolean),
    historical: true,
    cooldownClient: options.cooldownClient,
    cooldownScope: 'market-snapshots',
    sharedCooldown: true,
    timeoutMs: options.thornodeTimeoutMs || 12_000
  }));
  const [pools, oracle] = await Promise.all([
    fetchHistorical(`/thorchain/pools?height=${height}`),
    fetchHistorical(`/thorchain/oracle/prices?height=${height}`)
  ]);
  if (!Array.isArray(pools)) throw new Error(`Historical THORChain pools are invalid at height ${height}`);
  if (!Array.isArray(oracle?.prices)) throw new Error(`Historical THORChain oracle is invalid at height ${height}`);
  return { pools, oracle };
}

export function buildHistoricalPoolDislocationRows(anchor, state, binanceHistory = new Map()) {
  const oraclePrices = normalizeOraclePrices(state.oracle);
  const binanceTickers = new Map();
  for (const [symbol, closes] of binanceHistory) {
    const close = closes.get(anchor.observedAt);
    if (Number.isFinite(close) && close > 0) binanceTickers.set(symbol, { mid: close });
  }
  return buildObservationRows({
    pools: state.pools,
    oraclePrices,
    binanceTickers,
    observedAt: anchor.observedAt,
    poolObservedAt: anchor.blockTime,
    oracleObservedAt: anchor.blockTime,
    binanceObservedAt: new Date(Date.parse(anchor.observedAt) - 1).toISOString(),
    sampleOrigin: 'historical_backfill',
    thorchainHeight: anchor.height,
    poolPriceMethod: 'thornode-asset-tor',
    oraclePriceMethod: 'thornode-oracle',
    binancePriceMethod: 'kline-close'
  }).map((row) => ({
    ...row,
    oraclePriceMethod: row.oracleSymbol && row.oraclePriceUsd == null
      ? (oraclePrices.has(row.oracleSymbol)
        ? 'thornode-oracle-unaligned'
        : 'thornode-oracle-unavailable')
      : row.oraclePriceMethod,
    binancePriceMethod: row.binanceSymbol && row.binancePriceUsd == null
      ? (row.binancePriceMethod
        || (binanceHistory.get(row.binanceSymbol)?.has(anchor.observedAt)
          ? 'kline-close-unaligned'
          : 'kline-close-unavailable'))
      : row.binancePriceMethod
  }));
}

export async function loadPoolDislocationBackfillPlan(client, options = {}) {
  const { rows } = await client.query(
    `select min(observed_at) filter (where sample_origin = 'scheduled') as scheduled_start,
            max(observed_at) filter (where sample_origin = 'scheduled') as scheduled_end
     from pool_dislocation_observations`
  );
  const scheduledStart = rows[0]?.scheduled_start;
  const scheduledEnd = rows[0]?.scheduled_end;
  if (!scheduledStart || !scheduledEnd) {
    throw new Error('Pool-dislocation backfill requires at least one scheduled observation');
  }
  const startAt = timestamp(options.startAt || new Date(Date.parse(scheduledEnd) - WINDOW_MS));
  const endAt = timestamp(options.endAt || scheduledStart);
  const allBuckets = buildPoolDislocationBackfillBuckets(startAt, endAt);
  if (!allBuckets.length) return { startAt, endAt, allBuckets, pendingBuckets: [], existingBuckets: 0 };
  const existing = await client.query(
    `select distinct observed_at
     from pool_dislocation_observations
     where sample_origin = 'historical_backfill'
       and observed_at >= $1::timestamptz
       and observed_at < $2::timestamptz`,
    [startAt, endAt]
  );
  const existingBuckets = new Set(existing.rows.map((row) => timestamp(row.observed_at)));
  return {
    startAt,
    endAt,
    allBuckets,
    pendingBuckets: allBuckets.filter((bucket) => !existingBuckets.has(bucket)),
    existingBuckets: existingBuckets.size
  };
}

export async function loadPoolDislocationRecentGapRepairPlan(client, options = {}) {
  const endAt = floorToFiveMinuteBucket(options.endAt || new Date());
  const lookbackHours = Math.max(1, finiteInteger(
    options.lookbackHours ?? config.poolDislocationRepairLookbackHours
  ));
  const startAt = floorToFiveMinuteBucket(
    options.startAt || new Date(
      Date.parse(endAt) - (lookbackHours * 60 * 60 * 1000) + FIVE_MINUTES_MS
    )
  );
  const windowBuckets = buildPoolDislocationBackfillBuckets(startAt, endAt);
  if (!windowBuckets.length) {
    return {
      startAt,
      endAt,
      allBuckets: [],
      pendingBuckets: [],
      existingBuckets: 0,
      discoveredPendingBuckets: 0,
      deferredBuckets: 0
    };
  }
  const existing = await client.query(
    `with expected_references as (
       select asset, oracle_symbol, binance_symbol
       from jsonb_to_recordset($3::jsonb) as mapping (
         asset text,
         oracle_symbol text,
         binance_symbol text
       )
     )
     select observation.observed_at,
            bool_and(
              coalesce(observation.pool_price_method, 'thornode-asset-tor')
                <> 'thornode-core-snapshot'
            )
            and bool_and(
              coalesce(
                observation.oracle_symbol is not distinct from expected.oracle_symbol
                and (
                  (expected.oracle_symbol is null and observation.oracle_price_usd is null)
                  or (
                    expected.oracle_symbol is not null
                    and (
                      observation.oracle_price_usd is not null
                      or observation.oracle_price_method in (
                        'thornode-oracle-unavailable',
                        'thornode-oracle-unaligned'
                      )
                    )
                  )
                )
                and observation.binance_symbol is not distinct from expected.binance_symbol
                and (
                  (
                    expected.binance_symbol is null
                    and observation.binance_bid_usd is null
                    and observation.binance_ask_usd is null
                    and observation.binance_price_usd is null
                  )
                  or (
                    expected.binance_symbol is not null
                    and (
                      observation.binance_price_usd is not null
                      or observation.binance_price_method in (
                        'kline-close-unavailable',
                        'kline-close-unaligned',
                        'kline-close-usdt-to-usd-unavailable',
                        'kline-close-usdt-to-usd-unaligned'
                      )
                    )
                  )
                ),
                false
              )
            )
            and bool_and(
              observation.thorchain_height is not null
              and exists (
                select 1
                from thorchain_market_snapshots snapshot
                where snapshot.height = observation.thorchain_height
              )
            ) as authoritative
     from pool_dislocation_observations observation
     left join expected_references expected on expected.asset = observation.asset
     where observation.observed_at >= $1::timestamptz
       and observation.observed_at < $2::timestamptz
     group by observation.observed_at
     order by observation.observed_at`,
    [startAt, endAt, JSON.stringify(configuredReferenceMappings())]
  );
  const authoritativeBuckets = new Set(existing.rows
    .filter((row) => row.authoritative)
    .map((row) => timestamp(row.observed_at)));
  const pending = windowBuckets.filter((bucket) => !authoritativeBuckets.has(bucket));
  const maxBuckets = Math.max(1, finiteInteger(
    options.maxBuckets ?? config.poolDislocationRepairMaxBuckets
  ));
  const selected = pending.slice(0, maxBuckets);
  return {
    startAt,
    endAt,
    allBuckets: selected,
    pendingBuckets: selected,
    existingBuckets: authoritativeBuckets.size,
    discoveredPendingBuckets: pending.length,
    deferredBuckets: Math.max(0, pending.length - selected.length)
  };
}

export async function runPoolDislocationHistoricalBackfill(client, options = {}) {
  const report = options.onProgress || progressLogger;
  const plan = await (options.loadPlan || loadPoolDislocationBackfillPlan)(client, options);
  report({ stage: 'planned', total_buckets: plan.allBuckets.length, pending_buckets: plan.pendingBuckets.length });
  if (!plan.pendingBuckets.length) {
    return { ...plan, bucketsWritten: 0, observationsWritten: 0, alreadyComplete: true };
  }

  const [anchors, binanceHistory] = await Promise.all([
    retryPoolDislocationBackfillOperation(
      () => (options.resolveAnchors || resolvePoolDislocationBlockAnchors)(
        plan.pendingBuckets,
        { ...options, client }
      ),
      {
        attempts: options.retryAttempts,
        baseDelayMs: options.retryBaseDelayMs,
        maxDelayMs: options.retryMaxDelayMs,
        sleep: options.retrySleep,
        now: options.now,
        onRetry: ({ attempt, nextAttempt, attempts, delayMs, error }) => report({
          stage: 'retrying_rpc_anchors',
          attempt,
          next_attempt: nextAttempt,
          max_attempts: attempts,
          delay_ms: delayMs,
          error: String(error?.message || error)
        })
      }
    ),
    (options.loadBinanceHistory || loadBinanceBackfillHistory)(plan.pendingBuckets, options)
  ]);
  report({ stage: 'sources_ready', anchors: anchors.length, binance_symbols: binanceHistory.size });

  const batchSize = Math.max(1, finiteInteger(
    options.batchBuckets ?? config.poolDislocationBackfillBatchBuckets
  ));
  const requestDelayMs = Math.max(0, finiteInteger(
    options.requestDelayMs ?? config.poolDislocationBackfillRequestDelayMs
  ));
  let bucketsWritten = 0;
  let observationsWritten = 0;

  for (let index = 0; index < anchors.length; index += batchSize) {
    const batch = anchors.slice(index, index + batchSize);
    const batchRows = [];
    for (const anchor of batch) {
      const cached = await (options.loadMarketSnapshot || loadThorchainMarketSnapshot)(
        client,
        anchor.height
      );
      const state = cached
        ? { pools: cached.pools, oracle: { prices: cached.oraclePrices } }
        : await retryPoolDislocationBackfillOperation(
          () => (options.fetchHistoricalState || fetchHistoricalPoolDislocationState)(
            anchor.height,
            { ...options, client }
          ),
          {
            attempts: options.retryAttempts,
            baseDelayMs: options.retryBaseDelayMs,
            maxDelayMs: options.retryMaxDelayMs,
            sleep: options.retrySleep,
            now: options.now,
            onRetry: ({ attempt, nextAttempt, attempts, delayMs, error }) => report({
              stage: 'retrying_historical_state',
              observed_at: anchor.observedAt,
              height: anchor.height,
              attempt,
              next_attempt: nextAttempt,
              max_attempts: attempts,
              delay_ms: delayMs,
              error: String(error?.message || error)
            })
          }
        );
      if (!cached) {
        await (options.persistMarketSnapshot || persistThorchainMarketSnapshot)(client, {
          height: anchor.height,
          blockTime: anchor.blockTime,
          pools: state.pools,
          oraclePrices: state.oracle,
          source: 'pool-dislocation-backfill'
        });
      }
      if (state.oracle.prices.length === 0) {
        report({
          stage: 'source_gap',
          source: 'thornode_oracle',
          observed_at: anchor.observedAt,
          height: anchor.height
        });
      }
      const rows = (options.buildRows || buildHistoricalPoolDislocationRows)(anchor, state, binanceHistory);
      if (!rows.length) throw new Error(`No Available pools at historical height ${anchor.height}`);
      batchRows.push(...rows);
      await sleep(requestDelayMs);
    }
    const result = await (options.persistRows || persistPoolDislocationRows)(client, batchRows);
    bucketsWritten += batch.length;
    observationsWritten += Number(result?.rowCount ?? batchRows.length);
    report({
      stage: 'persisted',
      buckets_written: bucketsWritten,
      total_buckets: anchors.length,
      observations_written: observationsWritten,
      through: batch.at(-1)?.observedAt
    });
  }

  const verification = await client.query(
    `select count(distinct observed_at)::integer as buckets,
            count(*)::integer as observations,
            min(observed_at) as first_observed_at,
            max(observed_at) as last_observed_at
     from pool_dislocation_observations
     where observed_at = any($1::timestamptz[])`,
    [plan.allBuckets]
  );
  const verified = verification.rows[0] || {};
  if (Number(verified.buckets) !== plan.allBuckets.length) {
    throw new Error(`Historical backfill verification found ${verified.buckets || 0} of ${plan.allBuckets.length} buckets`);
  }
  return {
    ...plan,
    bucketsWritten,
    observationsWritten,
    alreadyComplete: false,
    verifiedBuckets: Number(verified.buckets),
    verifiedObservations: Number(verified.observations),
    firstObservedAt: verified.first_observed_at ? timestamp(verified.first_observed_at) : null,
    lastObservedAt: verified.last_observed_at ? timestamp(verified.last_observed_at) : null
  };
}
