import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel, getReadModel } from './read-models.js';
import { fetchMidgardChurns } from './midgard.js';
import { fetchThorchain } from './thornode.js';

export const THORNODE_CORE_MODEL_KEY = 'thornode-core:v1';
export const THORNODE_CORE_SCHEMA_VERSION = 1;
export const THORNODE_CORE_TTL_MS = 45_000;
export const THORNODE_CORE_LOCK_KEY = 'boonetools:thornode-core';

export const THORNODE_CORE_FIELDS = Object.freeze([
  { key: 'lastblock', path: '/thorchain/lastblock', cadenceMs: 15_000, valid: Array.isArray, provider: 'thornode' },
  { key: 'inbound_addresses', path: '/thorchain/inbound_addresses', cadenceMs: 60_000, valid: Array.isArray, provider: 'thornode' },
  { key: 'mimir', path: '/thorchain/mimir', cadenceMs: 60_000, valid: objectValue, provider: 'thornode' },
  { key: 'rune_supply', path: '/cosmos/bank/v1beta1/supply/by_denom?denom=rune', cadenceMs: 60_000, valid: runeSupplyValue, provider: 'thornode' },
  { key: 'node_mimirs', path: '/thorchain/mimir/nodes_all', cadenceMs: 60_000, valid: objectOrArray, provider: 'thornode' },
  { key: 'network', path: '/thorchain/network', cadenceMs: 120_000, valid: objectValue, provider: 'thornode' },
  { key: 'pools', path: '/thorchain/pools', cadenceMs: 120_000, valid: Array.isArray, provider: 'thornode' },
  { key: 'nodes', path: '/thorchain/nodes', cadenceMs: 300_000, valid: Array.isArray, provider: 'thornode' },
  { key: 'constants', path: '/thorchain/constants', cadenceMs: 900_000, valid: objectValue, provider: 'thornode' },
  { key: 'churns', path: '/churns', cadenceMs: 600_000, valid: Array.isArray, provider: 'midgard' }
]);

function objectValue(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function objectOrArray(value) {
  return objectValue(value) || Array.isArray(value);
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
  const dueFields = THORNODE_CORE_FIELDS.filter((field) => isDue(field, previous, nowMs));
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const fetchChurns = options.fetchMidgardChurns || fetchMidgardChurns;
  const results = await mapWithConcurrency(
    dueFields,
    Math.max(1, Math.trunc(Number(options.concurrency) || 3)),
    async (field) => {
      try {
        const value = field.provider === 'midgard'
          ? await fetchChurns({ cooldownClient: options.client })
          : await fetchThor(field.path, { cooldownClient: options.client });
        if (!field.valid(value)) throw new Error(`Invalid ${field.path} response`);
        return { field, ok: true, value };
      } catch (error) {
        return { field, ok: false, error: message(error) };
      }
    }
  );

  const payload = {
    schema_version: THORNODE_CORE_SCHEMA_VERSION,
    source: { live: 'thornode', churns: 'midgard' },
    as_of: nowIso,
    field_meta: { ...(previous?.field_meta || {}) },
    errors: {},
    warnings: []
  };
  for (const field of THORNODE_CORE_FIELDS) {
    if (previous && Object.prototype.hasOwnProperty.call(previous, field.key)) {
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
