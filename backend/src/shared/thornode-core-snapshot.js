import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel, getReadModel } from './read-models.js';
import {
  BIFROST_SCANNER_PROVIDER,
  fetchBifrostScannerInfo,
  isBifrostScannerInfo
} from './bifrost-scanner.js';
import { fetchMidgardChurns, fetchMidgardNetwork } from './midgard.js';
import { extractThorHeight, fetchThorchain } from './thornode.js';
import { loadLatestChainHead } from './chain-headers.js';

export const THORNODE_CORE_MODEL_KEY = 'thornode-core:v1';
export const THORNODE_CORE_SCHEMA_VERSION = 4;
export const THORNODE_CORE_TTL_MS = 45_000;
export const THORNODE_CORE_LOCK_KEY = 'boonetools:thornode-core';

const THORNODE_CORE_RECOVERY_GAP_BLOCKS = 100;

export const THORNODE_CORE_FIELDS = Object.freeze([
  { key: 'lastblock', path: '/thorchain/lastblock', cadenceMs: 15_000, valid: lastblockValue, provider: 'thornode' },
  { key: 'inbound_addresses', path: '/thorchain/inbound_addresses', cadenceMs: 60_000, valid: Array.isArray, provider: 'thornode' },
  { key: 'mimir', path: '/thorchain/mimir', cadenceMs: 60_000, valid: objectValue, provider: 'thornode' },
  { key: 'rune_supply', path: '/cosmos/bank/v1beta1/supply/by_denom?denom=rune', cadenceMs: 60_000, valid: runeSupplyValue, provider: 'thornode' },
  { key: 'node_mimirs', path: '/thorchain/mimir/nodes_all', cadenceMs: 60_000, valid: objectOrArray, provider: 'thornode' },
  { key: 'network', path: '/thorchain/network', cadenceMs: 120_000, valid: objectValue, provider: 'thornode' },
  { key: 'midgard_network', path: '/network', cadenceMs: 120_000, valid: objectValue, provider: 'midgard' },
  { key: 'pools', path: '/thorchain/pools', cadenceMs: 120_000, valid: Array.isArray, provider: 'thornode' },
  { key: 'oracle_prices', path: '/thorchain/oracle/prices', cadenceMs: 120_000, valid: oraclePricesValue, provider: 'thornode' },
  { key: 'nodes', path: '/thorchain/nodes', cadenceMs: 300_000, valid: Array.isArray, provider: 'thornode' },
  { key: 'bifrost_scanners', path: '/api/nodesInfo', cadenceMs: 300_000, valid: isBifrostScannerInfo, provider: BIFROST_SCANNER_PROVIDER },
  { key: 'constants', path: '/thorchain/constants', cadenceMs: 900_000, valid: objectValue, provider: 'thornode' },
  { key: 'churns', path: '/churns', cadenceMs: 600_000, valid: Array.isArray, provider: 'midgard' }
]);

function objectValue(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function lastblockValue(value) {
  const height = extractThorHeight(value);
  return Array.isArray(value) && Number.isSafeInteger(height) && height > 0;
}

async function knownChainHeight(options) {
  if (!options.loadLatestChainHead && !options.client?.query) return 0;
  try {
    const head = await (options.loadLatestChainHead || loadLatestChainHead)(options.client);
    const height = Number(head?.height);
    return Number.isSafeInteger(height) && height > 0 ? height : 0;
  } catch {
    // Header storage is an additional watermark. The last-good REST head still
    // protects against regression when that optional read is unavailable.
    return 0;
  }
}

async function selectThorNodeSource(fetchThor, options, minimumHeight) {
  let base = null;
  const validate = (value, context = {}) => {
    if (!lastblockValue(value)) return 'Invalid /thorchain/lastblock response';
    const height = extractThorHeight(value);
    if (height < minimumHeight) {
      return `THORNode provider is behind the known chain head (${height} < ${minimumHeight})`;
    }
    base = context.base || base;
    return null;
  };
  const lastblock = await fetchThor('/thorchain/lastblock', {
    bases: options.thornodeBases,
    cooldownClient: options.client,
    sharedCooldown: options.sharedCooldown,
    validateResponse: validate
  });
  // Injected fetchers need not implement the transport's validation hook.
  const invalid = validate(lastblock);
  if (invalid) throw new Error(invalid);
  return { base, lastblock };
}

function objectOrArray(value) {
  return objectValue(value) || Array.isArray(value);
}

function oraclePricesValue(value) {
  return objectValue(value)
    && Array.isArray(value.prices)
    && value.prices.some((row) => {
      const symbol = String(row?.symbol || '').trim();
      const price = Number(row?.price);
      return symbol && Number.isFinite(price) && price > 0;
    });
}

function runeSupplyValue(value) {
  return objectValue(value)
    && value.amount?.denom === 'rune'
    && /^\d+$/.test(String(value.amount?.amount || ''));
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function message(error) {
  return error?.message || String(error || 'unknown provider error');
}

function previousPayload(modelOrPayload) {
  if (modelOrPayload?.payload && typeof modelOrPayload.payload === 'object') {
    return modelOrPayload.payload;
  }
  return modelOrPayload && typeof modelOrPayload === 'object' ? modelOrPayload : null;
}

function isDue(field, previous, nowMs) {
  if (!previous || !Object.prototype.hasOwnProperty.call(previous, field.key)) return true;
  if (!field.valid(previous[field.key])) return true;
  const fetchedAt = timestampMs(previous?.field_meta?.[field.key]?.fetched_at);
  return fetchedAt <= 0 || nowMs - fetchedAt >= field.cadenceMs;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function coreSnapshotValue(snapshot, key, fallback = null) {
  const payload = previousPayload(snapshot);
  return payload && Object.prototype.hasOwnProperty.call(payload, key)
    ? payload[key]
    : fallback;
}

export function isThorNodeCoreSnapshotStale(snapshot, requiredFields = []) {
  const payload = previousPayload(snapshot);
  if (!payload || snapshot?.stale || payload.stale) return true;
  if (!payload.field_meta || requiredFields.length === 0) return false;
  return requiredFields.some((key) => {
    const status = payload.field_meta[key]?.status;
    return !Object.prototype.hasOwnProperty.call(payload, key)
      || status === 'reused'
      || status === 'error';
  });
}

export async function buildThorNodeCoreSnapshot(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const previous = previousPayload(options.previousSnapshot);
  const previousHeight = lastblockValue(previous?.lastblock) ? extractThorHeight(previous.lastblock) : 0;
  const knownHeight = await knownChainHeight(options);
  // The independently sampled RPC head may lead REST by a couple of blocks.
  // Never allow a regression relative to the last accepted REST response.
  const minimumHeight = Math.max(previousHeight, knownHeight - 2);
  const refreshThorFields = previous && (
    previous.schema_version !== THORNODE_CORE_SCHEMA_VERSION
    // Repair a previously poisoned cache immediately without defeating the
    // field cadences for ordinary advances between 15-second snapshots.
    || knownHeight - previousHeight > THORNODE_CORE_RECOVERY_GAP_BLOCKS
  );
  const dueFields = THORNODE_CORE_FIELDS.filter((field) => (
    (refreshThorFields && field.provider === 'thornode') || isDue(field, previous, nowMs)
  ));
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const fetchChurns = options.fetchMidgardChurns || fetchMidgardChurns;
  const fetchNetwork = options.fetchMidgardNetwork || fetchMidgardNetwork;
  const fetchScanners = options.fetchBifrostScannerInfo || fetchBifrostScannerInfo;
  let thorSource = null;
  let thorSourceError = null;
  if (dueFields.some((field) => field.provider === 'thornode')) {
    const headField = THORNODE_CORE_FIELDS.find((field) => field.key === 'lastblock');
    if (!dueFields.includes(headField)) dueFields.unshift(headField);
    try {
      thorSource = await selectThorNodeSource(fetchThor, options, minimumHeight);
    } catch (error) {
      thorSourceError = error;
    }
  }
  const results = await mapWithConcurrency(
    dueFields,
    Math.max(1, Math.trunc(Number(options.concurrency) || 3)),
    async (field) => {
      try {
        if (field.provider === 'thornode' && thorSourceError) throw thorSourceError;
        const value = field.provider === 'midgard'
          ? field.key === 'churns'
            ? await fetchChurns({ cooldownClient: options.client })
            : await fetchNetwork({ cooldownClient: options.client })
          : field.provider === BIFROST_SCANNER_PROVIDER
            ? await fetchScanners({ cooldownClient: options.client })
            : field.key === 'lastblock'
              ? thorSource.lastblock
              : await fetchThor(field.path, {
                // A healthy head from one source cannot validate another
                // source's Mimir, nodes, or inbound state after fallback.
                bases: thorSource.base ? [thorSource.base] : options.thornodeBases,
                cooldownClient: options.client,
                sharedCooldown: options.sharedCooldown,
                validateResponse: (value) => field.valid(value) ? null : `Invalid ${field.path} response`
              });
        if (!field.valid(value)) throw new Error(`Invalid ${field.path} response`);
        return { field, ok: true, value };
      } catch (error) {
        return { field, ok: false, error: message(error) };
      }
    }
  );

  const payload = {
    schema_version: THORNODE_CORE_SCHEMA_VERSION,
    source: { live: 'thornode', churns: 'midgard', scanner: BIFROST_SCANNER_PROVIDER },
    as_of: nowIso,
    field_meta: { ...(previous?.field_meta || {}) },
    errors: {},
    warnings: []
  };
  for (const field of THORNODE_CORE_FIELDS) {
    if (previous
      && Object.prototype.hasOwnProperty.call(previous, field.key)
      && field.valid(previous[field.key])) {
      payload[field.key] = previous[field.key];
      if (!dueFields.includes(field) && payload.field_meta[field.key]) {
        payload.field_meta[field.key] = {
          ...payload.field_meta[field.key],
          status: 'cached'
        };
      }
    }
  }

  for (const result of results) {
    const priorMeta = payload.field_meta[result.field.key] || {};
    if (result.ok) {
      payload[result.field.key] = result.value;
      payload.field_meta[result.field.key] = {
        provider: result.field.provider,
        cadence_ms: result.field.cadenceMs,
        fetched_at: nowIso,
        status: 'fresh'
      };
    } else {
      const reused = Object.prototype.hasOwnProperty.call(payload, result.field.key);
      payload.field_meta[result.field.key] = {
        ...priorMeta,
        provider: result.field.provider,
        cadence_ms: result.field.cadenceMs,
        status: reused ? 'reused' : 'error',
        last_error_at: nowIso,
        error: result.error
      };
      payload.errors[result.field.key] = result.error;
      payload.warnings.push(`${result.field.key}: ${result.error}${reused ? '; reused last successful value' : ''}`);
    }
  }

  const missing = THORNODE_CORE_FIELDS
    .filter((field) => !Object.prototype.hasOwnProperty.call(payload, field.key))
    .map((field) => field.key);
  const requiredStatusFields = ['lastblock', 'inbound_addresses', 'mimir', 'nodes'];
  const missingRequired = requiredStatusFields.filter((key) => missing.includes(key));
  const dueThor = results.filter((result) => result.field.provider === 'thornode');
  const thorRefreshSucceeded = dueThor.some((result) => result.ok);
  const thorRefreshFailed = dueThor.some((result) => !result.ok);

  if (missingRequired.length > 0) {
    throw new Error(`THORNode core snapshot missing required fields: ${missingRequired.join(', ')}`);
  }

  payload.partial = payload.warnings.length > 0 || missing.length > 0;
  // A cycle in which every due THORNode call fails is provider-total failure,
  // even if Midgard succeeds or older field values remain usable.
  payload.stale = dueThor.length > 0 && thorRefreshFailed && !thorRefreshSucceeded;
  payload.missing_fields = missing;

  const fetchedTimes = Object.values(payload.field_meta)
    .map((meta) => timestampMs(meta?.fetched_at))
    .filter((value) => value > 0);
  payload.source_updated_at = fetchedTimes.length
    ? new Date(Math.max(...fetchedTimes)).toISOString()
    : null;

  return payload;
}

export async function getThorNodeCoreSnapshot(options = {}) {
  return getReadModel(THORNODE_CORE_MODEL_KEY, {
    ...options,
    allowStale: options.allowStale !== false
  });
}

export async function runThorNodeCoreSnapshot(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(THORNODE_CORE_LOCK_KEY, async (client) => {
    const previous = await (options.getReadModel || getReadModel)(THORNODE_CORE_MODEL_KEY, {
      client,
      allowStale: true
    });
    return (options.publish || buildAndPublishReadModel)({
      modelKey: THORNODE_CORE_MODEL_KEY,
      schemaVersion: THORNODE_CORE_SCHEMA_VERSION,
      ttlMs: options.ttlMs || THORNODE_CORE_TTL_MS,
      client,
      now: options.now,
      build: async () => {
        const payload = await buildThorNodeCoreSnapshot({
          ...options,
          client,
          previousSnapshot: previous
        });
        return {
          payload,
          generatedAt: payload.as_of,
          sourceUpdatedAt: payload.source_updated_at,
          metadata: {
            partial: payload.partial,
            stale: payload.stale,
            warnings: payload.warnings,
            field_meta: payload.field_meta
          },
          stats: {
            refreshed: Object.values(payload.field_meta).filter((meta) => meta.status === 'fresh').length,
            cached: Object.values(payload.field_meta).filter((meta) => meta.status === 'cached').length,
            reused: Object.values(payload.field_meta).filter((meta) => meta.status === 'reused').length,
            errors: payload.warnings.length,
            stale: payload.stale
          }
        };
      }
    });
  });
}
