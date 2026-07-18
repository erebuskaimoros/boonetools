import { TtlSingleFlightCache } from '../lib/ttl-cache.js';
import { fetchMidgardChurns } from './midgard.js';
import { fetchThorchain } from './thornode.js';

const SNAPSHOT_TTL_MS = 15_000;
const snapshotCache = new TtlSingleFlightCache({ ttlMs: SNAPSHOT_TTL_MS });

const SNAPSHOT_FIELDS = Object.freeze([
  {
    key: 'inbound_addresses',
    path: '/thorchain/inbound_addresses',
    fallback: [],
    valid: Array.isArray
  },
  {
    key: 'nodes',
    path: '/thorchain/nodes',
    fallback: [],
    valid: Array.isArray
  },
  {
    key: 'mimir',
    path: '/thorchain/mimir',
    fallback: {},
    valid: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  },
  {
    key: 'lastblock',
    path: '/thorchain/lastblock',
    fallback: [],
    valid: Array.isArray
  }
]);

function errorMessage(reason, fallback) {
  return reason?.message || String(reason || fallback);
}

async function loadNetworkSnapshot(dependencies = {}) {
  const fetchThor = dependencies.fetchThorchain || fetchThorchain;
  const fetchChurns = dependencies.fetchMidgardChurns || fetchMidgardChurns;
  const requests = SNAPSHOT_FIELDS.map((field) => fetchThor(field.path, {
    validateResponse: (value) => field.valid(value)
      ? null
      : `Invalid ${field.path} response`
  }));
  requests.push(fetchChurns());
  const results = await Promise.allSettled(requests);
  const snapshot = {};
  const errors = {};

  for (const [index, field] of SNAPSHOT_FIELDS.entries()) {
    const result = results[index];
    if (result.status === 'fulfilled' && field.valid(result.value)) {
      snapshot[field.key] = result.value;
    } else {
      snapshot[field.key] = field.fallback;
      errors[field.key] = result.status === 'rejected'
        ? errorMessage(result.reason, `Unable to load ${field.key}`)
        : `Invalid ${field.path} response`;
    }
  }

  const churnResult = results[SNAPSHOT_FIELDS.length];
  if (churnResult.status === 'fulfilled' && Array.isArray(churnResult.value)) {
    snapshot.churns = churnResult.value;
  } else {
    snapshot.churns = [];
    errors.churns = churnResult.status === 'rejected'
      ? errorMessage(churnResult.reason, 'Unable to load churns')
      : 'Invalid Midgard churn response';
  }

  if (Object.keys(errors).length === results.length) {
    throw new AggregateError(
      results.filter((result) => result.status === 'rejected').map((result) => result.reason),
      `Network snapshot unavailable: ${Object.values(errors).join('; ')}`
    );
  }

  const warnings = Object.entries(errors).map(([field, message]) => `${field}: ${message}`);

  return {
    ...snapshot,
    as_of: new Date().toISOString(),
    source: {
      live: 'thornode',
      churns: 'midgard'
    },
    errors,
    warnings,
    partial: warnings.length > 0,
    stale: false,
    warning: warnings.join('; ')
  };
}

export async function getNetworkSnapshot(options = {}) {
  const cache = options.cache || snapshotCache;
  return cache.getOrLoad('network-status', () => loadNetworkSnapshot(options), {
    forceRefresh: Boolean(options.forceRefresh),
    staleIfError: true,
    onStale: (value, refreshError) => ({
      ...value,
      stale: true,
      partial: true,
      warnings: [...(value.warnings || []), refreshError?.message || 'Live network snapshot refresh failed'],
      warning: refreshError?.message || 'Live network snapshot refresh failed'
    })
  });
}

export function clearNetworkSnapshotCache() {
  snapshotCache.clear();
}
