import { TtlSingleFlightCache } from '../lib/ttl-cache.js';
import { fetchMidgardChurns } from './midgard.js';
import { fetchThorchain } from './thornode.js';
import { getThorNodeCoreSnapshot } from './thornode-core-snapshot.js';
import {
  BIFROST_SCANNER_PROVIDER,
  fetchBifrostScannerInfo,
  isBifrostScannerInfo
} from './bifrost-scanner.js';

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
  const fetchScanners = dependencies.fetchBifrostScannerInfo || fetchBifrostScannerInfo;
  const requests = SNAPSHOT_FIELDS.map((field) => fetchThor(field.path, {
    validateResponse: (value) => field.valid(value)
      ? null
      : `Invalid ${field.path} response`
  }));
  requests.push(fetchChurns());
  requests.push(fetchScanners());
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

  const scannerResult = results[SNAPSHOT_FIELDS.length + 1];
  if (scannerResult.status === 'fulfilled' && isBifrostScannerInfo(scannerResult.value)) {
    snapshot.bifrost_scanners = scannerResult.value;
  } else {
    snapshot.bifrost_scanners = [];
    errors.bifrost_scanners = scannerResult.status === 'rejected'
      ? errorMessage(scannerResult.reason, 'Unable to load Bifrost scanner state')
      : 'Invalid Bifrost scanner response';
  }

  const thornodeSuccesses = results
    .slice(0, SNAPSHOT_FIELDS.length)
    .filter((result, index) => (
      result.status === 'fulfilled' && SNAPSHOT_FIELDS[index].valid(result.value)
    )).length;
  if (thornodeSuccesses === 0) {
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
      churns: 'midgard',
      scanner: BIFROST_SCANNER_PROVIDER
    },
    errors,
    warnings,
    partial: warnings.length > 0,
    stale: false,
    warning: warnings.join('; ')
  };
}

function fromCoreReadModel(model) {
  const payload = model?.payload;
  if (!payload) throw new Error('Durable THORNode core snapshot is not available');
  const errors = payload.errors || {};
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  return {
    inbound_addresses: Array.isArray(payload.inbound_addresses) ? payload.inbound_addresses : [],
    nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
    bifrost_scanners: Array.isArray(payload.bifrost_scanners) ? payload.bifrost_scanners : [],
    mimir: payload.mimir && typeof payload.mimir === 'object' ? payload.mimir : {},
    lastblock: Array.isArray(payload.lastblock) ? payload.lastblock : [],
    network: payload.network && typeof payload.network === 'object' ? payload.network : {},
    pools: Array.isArray(payload.pools) ? payload.pools : [],
    constants: payload.constants && typeof payload.constants === 'object' ? payload.constants : {},
    node_mimirs: payload.node_mimirs ?? {},
    churns: Array.isArray(payload.churns) ? payload.churns : [],
    field_meta: payload.field_meta || {},
    as_of: payload.as_of || model.generatedAt,
    source_updated_at: payload.source_updated_at || model.sourceUpdatedAt,
    source: payload.source || {
      live: 'thornode',
      churns: 'midgard',
      scanner: BIFROST_SCANNER_PROVIDER
    },
    errors,
    warnings,
    partial: Boolean(payload.partial || warnings.length),
    stale: Boolean(model.stale || payload.stale),
    warning: warnings.join('; ')
  };
}

export async function getNetworkSnapshot(options = {}) {
  const hasLiveDependencies = Boolean(
    options.cache || options.fetchThorchain || options.fetchMidgardChurns || options.fetchBifrostScannerInfo
  );
  if (!hasLiveDependencies) {
    const model = await (options.getThorNodeCoreSnapshot || getThorNodeCoreSnapshot)({
      client: options.client,
      allowStale: true,
      cache: options.readModelCache
    });
    return fromCoreReadModel(model);
  }
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
