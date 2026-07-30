import { withAdvisoryLock } from '../db/lock.js';
import { config } from '../lib/config.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { providerLifecycleHooks } from '../shared/provider-cooldown.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import { fetchThorchain } from '../shared/thornode.js';
import {
  coreSnapshotValue,
  getThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from '../shared/thornode-core-snapshot.js';
import { isTransientPoolDislocationBackfillError } from '../shared/pool-dislocation-backfill.js';
import {
  POOL_DISLOCATION_MODEL_KEY,
  POOL_DISLOCATION_RETENTION_DAYS,
  POOL_DISLOCATION_SCHEMA_VERSION,
  POOL_DISLOCATION_TTL_MS,
  POOL_REFERENCE_MAPPINGS,
  binanceSymbolsForPools,
  buildObservationRows,
  buildPoolDislocationSummary,
  floorToFiveMinuteBucket,
  normalizeBinanceBookTickers,
  normalizeChainTradingStatus,
  normalizeOraclePrices
} from '../shared/pool-dislocation.js';
import {
  loadPoolDislocationWindow as loadStoredPoolDislocationWindow,
  persistPoolDislocationRows
} from '../shared/pool-dislocation-store.js';

const LOCK_KEY = 'boonetools:pool-dislocation';
const BINANCE_TIMEOUT_MS = 6_000;
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

function errorMessage(error) {
  return error?.message || String(error || 'unknown provider error');
}

function sourceResult(result) {
  return result.status === 'fulfilled'
    ? { status: 'fresh', observed_at: result.observedAt, error: null }
    : { status: 'error', observed_at: null, error: errorMessage(result.reason) };
}

async function timedResult(operation, now) {
  try {
    const value = await operation();
    return { status: 'fulfilled', value, observedAt: now().toISOString() };
  } catch (reason) {
    return { status: 'rejected', reason, observedAt: now().toISOString() };
  }
}

function sleep(delayMs) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

export async function retryPoolDislocationSnapshotOperation(operation, options = {}) {
  const attempts = Math.max(1, Math.trunc(Number(
    options.attempts ?? config.poolDislocationSnapshotRetryAttempts
  )) || 1);
  const baseDelayMs = Math.max(0, Math.trunc(Number(
    options.baseDelayMs ?? config.poolDislocationSnapshotRetryBaseDelayMs
  )) || 0);
  const sleepFor = options.sleep || sleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation({
        attempt,
        bypassSharedCooldown: attempt > 1
      });
    } catch (error) {
      if (attempt >= attempts || !isTransientPoolDislocationBackfillError(error)) throw error;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
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
  throw new Error('Pool-dislocation snapshot retry loop exhausted unexpectedly');
}

export function resolvePoolDislocationCorePoolFallback(snapshot, options = {}) {
  const payload = snapshot?.payload && typeof snapshot.payload === 'object'
    ? snapshot.payload
    : snapshot;
  const pools = coreSnapshotValue(payload, 'pools');
  const observedAt = payload?.field_meta?.pools?.fetched_at;
  const observedMs = Date.parse(String(observedAt || ''));
  const requestedMs = Date.parse(String(options.observedAt || ''));
  const maxAgeMs = Math.max(0, Number(
    options.maxAgeMs ?? config.poolDislocationCoreFallbackMaxAgeMs
  ) || 0);
  const ageMs = requestedMs - observedMs;
  if (!Array.isArray(pools)
    || pools.length === 0
    || !Number.isFinite(observedMs)
    || !Number.isFinite(requestedMs)
    || ageMs < -CLOCK_SKEW_TOLERANCE_MS
    || ageMs > maxAgeMs) {
    return null;
  }
  return { pools, observedAt: new Date(observedMs).toISOString(), ageMs: Math.max(0, ageMs) };
}

async function collectRequiredPoolResult(options, startedAt) {
  const fetchPools = options.fetchPools || ((context = {}) => fetchThorchain('/thorchain/pools', {
    bases: config.poolDislocationThornodeUrls,
    sharedCooldown: !context.bypassSharedCooldown,
    validateResponse: (payload) => Array.isArray(payload) ? null : 'Invalid THORNode pools response'
  }));
  try {
    const value = await retryPoolDislocationSnapshotOperation(fetchPools, {
      attempts: options.snapshotRetryAttempts,
      baseDelayMs: options.snapshotRetryBaseDelayMs,
      sleep: options.snapshotRetrySleep,
      onRetry: options.onSnapshotRetry
    });
    return {
      status: 'fulfilled',
      value,
      observedAt: (options.now || (() => new Date()))().toISOString(),
      poolPriceMethod: 'thornode-asset-tor',
      fallback: false
    };
  } catch (reason) {
    try {
      const snapshot = await (options.getThorNodeCoreSnapshot || getThorNodeCoreSnapshot)({
        client: options.client,
        allowStale: true,
        cache: false
      });
      const fallback = resolvePoolDislocationCorePoolFallback(snapshot, {
        observedAt: startedAt,
        maxAgeMs: options.coreFallbackMaxAgeMs
      });
      if (fallback) {
        return {
          status: 'fulfilled',
          value: fallback.pools,
          observedAt: fallback.observedAt,
          poolPriceMethod: 'thornode-core-snapshot',
          fallback: true,
          fallbackAgeMs: fallback.ageMs,
          reason
        };
      }
    } catch {
      // Preserve the authoritative live-provider error below.
    }
    return { status: 'rejected', reason, observedAt: startedAt };
  }
}

function allConfiguredBinanceSymbols() {
  return [...new Set(Object.values(POOL_REFERENCE_MAPPINGS).map((mapping) => mapping.binance).filter(Boolean))]
    .sort();
}

export async function fetchBinanceBookTickers(symbols = allConfiguredBinanceSymbols(), options = {}) {
  const normalized = [...new Set(symbols.map((symbol) => String(symbol || '').toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) return [];
  const path = `/api/v3/ticker/bookTicker?symbols=${encodeURIComponent(JSON.stringify(normalized))}`;
  return requestFromProviders({
    bases: options.bases || config.binanceApiBaseUrls,
    path,
    timeoutMs: options.timeoutMs || BINANCE_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    headers: { Accept: 'application/json' },
    ...providerLifecycleHooks({ client: options.cooldownClient, enabled: options.sharedCooldown }),
    validateResponse: (payload) => Array.isArray(payload) ? null : 'Invalid Binance bookTicker response',
    errorMessage: ({ status }) => `Binance bookTicker request failed (${status})`
  });
}

export async function loadPoolTradingStatus(options = {}) {
  const coreModel = await (options.getThorNodeCoreSnapshot || getThorNodeCoreSnapshot)({
    client: options.client,
    allowStale: true,
    cache: false
  });
  if (!coreModel || isThorNodeCoreSnapshotStale(coreModel, ['inbound_addresses'])) {
    throw new Error('Durable THORNode inbound-address state is unavailable or stale');
  }
  const inboundAddresses = coreSnapshotValue(coreModel, 'inbound_addresses');
  if (!Array.isArray(inboundAddresses)) {
    throw new Error('Durable THORNode inbound-address state is invalid');
  }
  return inboundAddresses;
}

export async function collectPoolDislocationSnapshot(options = {}) {
  const now = options.now || (() => new Date());
  const startedAt = now();
  const fetchOracle = options.fetchOracle || (() => fetchThorchain('/thorchain/oracle/prices', {
    bases: config.poolDislocationThornodeUrls,
    sharedCooldown: true,
    validateResponse: (payload) => Array.isArray(payload?.prices) ? null : 'Invalid THORChain oracle response'
  }));
  const fetchInboundAddresses = options.fetchInboundAddresses
    || (() => loadPoolTradingStatus(options));
  const fetchBinance = options.fetchBinance || (() => fetchBinanceBookTickers(
    allConfiguredBinanceSymbols(),
    { sharedCooldown: true }
  ));

  const [poolResult, oracleResult, binanceResult, inboundResult] = await Promise.all([
    collectRequiredPoolResult({ ...options, now }, startedAt),
    timedResult(fetchOracle, now),
    timedResult(fetchBinance, now),
    timedResult(fetchInboundAddresses, now)
  ]);
  if (poolResult.status === 'rejected') {
    throw new Error(`THORChain pools unavailable: ${errorMessage(poolResult.reason)}`);
  }

  const pools = poolResult.value;
  const relevantBinanceSymbols = new Set(binanceSymbolsForPools(pools));
  const binanceTickers = binanceResult.status === 'fulfilled'
    ? new Map([...normalizeBinanceBookTickers(binanceResult.value)]
      .filter(([symbol]) => relevantBinanceSymbols.has(symbol)))
    : new Map();
  const oraclePrices = oracleResult.status === 'fulfilled'
    ? normalizeOraclePrices(oracleResult.value)
    : new Map();
  const sources = {
    pool: poolResult.fallback
      ? {
        status: 'cached',
        observed_at: poolResult.observedAt,
        provider: 'thornode-core-snapshot',
        age_ms: poolResult.fallbackAgeMs,
        error: errorMessage(poolResult.reason)
      }
      : sourceResult(poolResult),
    oracle: sourceResult(oracleResult),
    binance: sourceResult(binanceResult),
    trading: {
      ...sourceResult(inboundResult),
      provider: 'thornode-core-snapshot'
    }
  };
  const warnings = Object.entries(sources)
    .filter(([, source]) => source.status !== 'fresh' && source.error)
    .map(([name, source]) => `${name}: ${source.error}`);
  const observedAt = floorToFiveMinuteBucket(startedAt);
  const rows = buildObservationRows({
    pools,
    oraclePrices,
    binanceTickers,
    observedAt,
    poolObservedAt: poolResult.observedAt,
    oracleObservedAt: sources.oracle.observed_at,
    binanceObservedAt: sources.binance.observed_at,
    poolPriceMethod: poolResult.poolPriceMethod
  });
  if (rows.length === 0) throw new Error('THORChain returned no Available pools');

  const chainTrading = inboundResult.status === 'fulfilled'
    ? normalizeChainTradingStatus(inboundResult.value)
    : normalizeChainTradingStatus();

  return { observedAt, rows, sources, warnings, chainTrading };
}

export async function persistPoolDislocationSnapshot(client, snapshot, options = {}) {
  return persistPoolDislocationRows(client, snapshot.rows, {
    pruneBefore: snapshot.observedAt,
    retentionDays: options.retentionDays || POOL_DISLOCATION_RETENTION_DAYS
  });
}

export async function loadPoolDislocationWindow(client, asOf) {
  return loadStoredPoolDislocationWindow(client, asOf);
}

function compactRunResult(result) {
  if (!result?.model) return result;
  return {
    ok: result.ok,
    runId: result.runId,
    model: {
      key: result.model.key,
      generatedAt: result.model.generatedAt,
      sourceUpdatedAt: result.model.sourceUpdatedAt,
      freshUntil: result.model.freshUntil,
      pools: result.model.payload?.coverage?.total_pools || 0
    }
  };
}

export async function runPoolDislocationScheduler(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  const publish = options.publish || buildAndPublishReadModel;
  const result = await lockRunner(LOCK_KEY, (client) => publish({
    modelKey: POOL_DISLOCATION_MODEL_KEY,
    schemaVersion: POOL_DISLOCATION_SCHEMA_VERSION,
    ttlMs: options.ttlMs || POOL_DISLOCATION_TTL_MS,
    client,
    now: options.now,
    build: async () => {
      const snapshot = await (options.collect || collectPoolDislocationSnapshot)({ ...options, client });
      await (options.persist || persistPoolDislocationSnapshot)(client, snapshot, options);
      const rows = await (options.loadWindow || loadPoolDislocationWindow)(client, snapshot.observedAt);
      const payload = buildPoolDislocationSummary(rows, {
        asOf: snapshot.observedAt,
        sources: snapshot.sources,
        warnings: snapshot.warnings,
        chainTrading: snapshot.chainTrading,
        currentAssets: snapshot.rows.map((row) => row.asset)
      });
      return {
        payload,
        generatedAt: snapshot.observedAt,
        sourceUpdatedAt: snapshot.observedAt,
        metadata: { sources: snapshot.sources, warnings: snapshot.warnings },
        stats: {
          observations_written: snapshot.rows.length,
          history_rows: rows.length,
          pools: payload.coverage.total_pools,
          fully_observed: payload.coverage.fully_observed,
          warnings: snapshot.warnings.length
        }
      };
    }
  }));
  return compactRunResult(result);
}
