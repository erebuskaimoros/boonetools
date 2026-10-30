import { booneToolsApi } from './boonetools.js';

const CACHE_TTL_MS = 10_000;
const cache = new Map();
const inflight = new Map();

const FIELD_BY_PATH = Object.freeze({
  '/thorchain/inbound_addresses': 'inbound_addresses',
  '/thorchain/nodes': 'nodes',
  '/thorchain/mimir': 'mimir',
  '/thorchain/lastblock': 'lastblock',
  '/thorchain/network': 'network',
  '/thorchain/pools': 'pools',
  '/thorchain/constants': 'constants',
  '/thorchain/version': 'version',
  '/thorchain/mimir/nodes_all': 'node_mimirs'
});

function normalizedPath(path) {
  return String(path || '').split('?')[0];
}

function pathDescriptor(path) {
  const normalized = normalizedPath(path);
  if (FIELD_BY_PATH[normalized]) return { field: FIELD_BY_PATH[normalized] };
  if (normalized.startsWith('/thorchain/mimir/key/')) {
    return {
      field: 'mimir',
      mimirKey: decodeURIComponent(normalized.slice('/thorchain/mimir/key/'.length)).toUpperCase()
    };
  }
  const poolMatch = normalized.match(/^\/thorchain\/pool\/([^/]+)$/);
  if (poolMatch) {
    return { field: 'pools', pool: decodeURIComponent(poolMatch[1]).toUpperCase() };
  }
  return null;
}

/** One snapshot field, optionally narrowed (for example `{ fields: 'status,total_bond' }` on nodes). */
export async function loadCoreSnapshotField(field, query = {}) {
  const key = JSON.stringify([field, query]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;
  if (inflight.has(key)) return inflight.get(key);
  const pending = booneToolsApi.get('/network-snapshot', {
    query: { ...query, field },
    headers: { Accept: 'application/vnd.boonetools.v2+json' },
    normalizeEnvelope: false,
    errorMessage: `BooneTools core snapshot field ${field} is unavailable`
  }).then((envelope) => {
    const value = envelope?.data;
    cache.set(key, { value, fetchedAt: Date.now() });
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

export async function resolveCoreSnapshotPath(path, options = {}) {
  if (options.blockHeight || String(path || '').includes('?height=')) {
    return { handled: false, value: null };
  }
  const descriptor = pathDescriptor(path);
  if (!descriptor) return { handled: false, value: null };
  const fieldValue = await loadCoreSnapshotField(descriptor.field);
  if (descriptor.mimirKey) {
    const entry = Object.entries(fieldValue || {}).find(
      ([key]) => String(key).toUpperCase() === descriptor.mimirKey
    );
    if (!entry) throw new Error(`Mimir key ${descriptor.mimirKey} is not in the core snapshot`);
    return { handled: true, value: String(entry[1]) };
  }
  if (descriptor.pool) {
    const pool = (Array.isArray(fieldValue) ? fieldValue : []).find(
      (row) => String(row?.asset || '').toUpperCase() === descriptor.pool
    );
    if (!pool) throw new Error(`Pool ${descriptor.pool} is not in the core snapshot`);
    return { handled: true, value: pool };
  }
  return { handled: true, value: fieldValue };
}

export function clearCoreSnapshotCache() {
  cache.clear();
  inflight.clear();
}
