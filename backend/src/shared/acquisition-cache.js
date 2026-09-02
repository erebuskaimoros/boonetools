import { createHash } from 'node:crypto';
import { recordAcquisitionMetric } from '../lib/acquisition-metrics.js';

const flightsByClient = new WeakMap();
const acquisitionQueues = new WeakMap();
const defaultScope = {};

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function acquisitionIdentity(value) {
  const identity = typeof value === 'string' ? value : JSON.stringify(stableValue(value));
  if (!identity || identity.length > 8192) throw new Error('Invalid acquisition identity');
  return identity;
}

// Provider configuration may contain credentials; use its hash in shared keys.
export function acquisitionSourceKey(value) {
  return createHash('sha256').update(acquisitionIdentity(value)).digest('hex');
}

function namespaceKey(value) {
  const namespace = String(value || '').trim();
  if (!namespace || namespace.length > 200) throw new Error('Invalid acquisition namespace');
  return namespace;
}

function iso(value, fallback = null) {
  if (value == null) return fallback;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error('Invalid acquisition timestamp');
  return time.toISOString();
}

async function withClient(client, run) {
  if (client) return run(client);
  const { getClient } = await import('../db/pool.js');
  const owned = await getClient();
  try { return await run(owned); }
  finally { owned.release(); }
}

async function withAcquisitionSession(client, run) {
  if (!client) return withClient(null, run);
  // A pg Client has one statement queue. Waiting for B's session lock must not
  // block the save/unlock for A on that same client: another process can hold B
  // while waiting for A. Complete each acquisition before starting the next.
  const previous = acquisitionQueues.get(client) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => run(client));
  acquisitionQueues.set(client, pending);
  try { return await pending; }
  finally { if (acquisitionQueues.get(client) === pending) acquisitionQueues.delete(client); }
}

function normalize(row, nowMs) {
  if (!row) return null;
  const completedAt = iso(row.completed_at);
  const observedAt = iso(row.observed_at);
  const expiresAt = iso(row.expires_at);
  return {
    payload: row.payload_json, source: row.source,
    observedAt, expiresAt, completedAt, metadata: row.metadata_json || {},
    stale: !completedAt && (!expiresAt || Date.parse(expiresAt) <= nowMs || Date.parse(observedAt) > nowMs)
  };
}

export async function loadAcquisition(client, namespace, identity, options = {}) {
  return withClient(client, async (db) => {
    const { rows } = await db.query(
      `select namespace, identity, payload_json, source, observed_at, expires_at, completed_at, metadata_json
       from source_observations where namespace = $1 and identity = $2`,
      [namespaceKey(namespace), acquisitionIdentity(identity)]
    );
    const record = normalize(rows[0], Number(options.nowMs ?? Date.now()));
    if (!record || (options.requireComplete && !record.completedAt) || (record.stale && !options.allowStale)) return null;
    return record;
  });
}

export async function saveAcquisition(client, input, options = {}) {
  return withClient(client, async (db) => {
    const namespace = namespaceKey(input.namespace);
    const identity = acquisitionIdentity(input.identity);
    if (input.payload === undefined) throw new Error('Acquisition payload is required');
    const { rows } = await db.query(
      `insert into source_observations as current (
         namespace, identity, payload_json, source, observed_at, expires_at, completed_at, metadata_json
       ) values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb)
       on conflict (namespace, identity) do update set
         payload_json = excluded.payload_json, source = excluded.source,
         observed_at = excluded.observed_at, expires_at = excluded.expires_at,
         completed_at = excluded.completed_at, metadata_json = excluded.metadata_json
       where current.completed_at is null or ($9::boolean and excluded.completed_at is not null)
       returning namespace, identity, payload_json, source, observed_at, expires_at, completed_at, metadata_json`,
      [namespace, identity, JSON.stringify(input.payload), String(input.source || namespace),
        iso(input.observedAt, new Date().toISOString()), iso(input.expiresAt), iso(input.completedAt),
        JSON.stringify(input.metadata || {}), Boolean(options.force)]
    );
    return rows[0] ? normalize(rows[0], Date.now())
      : loadAcquisition(db, namespace, identity, { allowStale: true });
  });
}

/** Coalesce identical requests and double-check durable state under a session lock.
 * Callers must pass the supplied client to provider cooldown hooks, so waiting
 * cache callers cannot exhaust the pool needed by the lock owner's provider work.
 */
export async function acquireCached(client, options) {
  const namespace = namespaceKey(options.namespace);
  const identity = acquisitionIdentity(options.identity);
  const scope = client || defaultScope;
  let flights = flightsByClient.get(scope);
  if (!flights) { flights = new Map(); flightsByClient.set(scope, flights); }
  const lockKey = JSON.stringify([namespace, identity]);
  if (flights.has(lockKey)) {
    recordAcquisitionMetric(namespace, 'coalesced');
    return flights.get(lockKey);
  }
  const promise = withAcquisitionSession(client, async (db) => {
    const nowMs = () => Number(typeof options.nowMs === 'function' ? options.nowMs() : options.nowMs ?? Date.now());
    const usable = (record) => record && (!options.validate || options.validate(record.payload) === true);
    const cached = await loadAcquisition(db, namespace, identity, { nowMs: nowMs() });
    if (usable(cached) && !options.force) {
      recordAcquisitionMetric(namespace, 'hit');
      return cached;
    }
    await db.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    try {
      const rechecked = await loadAcquisition(db, namespace, identity, { nowMs: nowMs() });
      if (usable(rechecked) && !options.force) {
        recordAcquisitionMetric(namespace, 'hit');
        return rechecked;
      }
      recordAcquisitionMetric(namespace, 'miss');
      const payload = await options.load(db);
      if (payload === undefined || (options.validate && options.validate(payload) !== true)) {
        throw new Error(`Invalid acquisition response for ${namespace}`);
      }
      const observedAt = new Date(nowMs()).toISOString();
      const ttlMs = Math.max(1, Number(options.ttlMs) || 60_000);
      const saved = await saveAcquisition(db, {
        namespace, identity, payload, source: options.source || namespace, observedAt,
        expiresAt: options.immutable ? null : new Date(nowMs() + ttlMs).toISOString(),
        completedAt: options.immutable ? observedAt : null, metadata: options.metadata
      }, { force: Boolean(options.force) });
      if (!usable(saved)) throw new Error(`Invalid completed acquisition for ${namespace}; explicit repair required`);
      return saved;
    } finally {
      await db.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
    }
  });
  flights.set(lockKey, promise);
  try { return await promise; }
  finally { if (flights.get(lockKey) === promise) flights.delete(lockKey); }
}
