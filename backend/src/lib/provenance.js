import { upsertRows } from '../db/sql.js';

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_SOURCE_PRIORITY = Object.freeze({
  dune: 100,
  thornode: 90,
  rpc: 80,
  ws: 80,
  midgard: 70,
  backfill: 50,
  scheduled: 40,
  unknown: 0
});

function safeSource(source) {
  return String(source || 'unknown').trim().toLowerCase() || 'unknown';
}

function safeIso(value, fallback = new Date().toISOString()) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export function choosePreferredSource(left, right) {
  const normalizedLeft = safeSource(left);
  const normalizedRight = safeSource(right);
  const leftRank = EVENT_SOURCE_PRIORITY[normalizedLeft] ?? 10;
  const rightRank = EVENT_SOURCE_PRIORITY[normalizedRight] ?? 10;
  return rightRank > leftRank ? normalizedRight : normalizedLeft;
}

export function eventSourceRank(source) {
  const normalized = safeSource(source);
  return EVENT_SOURCE_PRIORITY[normalized] ?? 10;
}

export function canonicalNodeVoteKey(row) {
  const txId = String(row?.tx_id || '').trim().toUpperCase();
  if (txId) {
    return ['node-vote', txId, String(row?.event_index ?? 0)].join(':');
  }

  return [
    'node-vote',
    String(row?.height || ''),
    String(row?.event_index ?? 0),
    String(row?.node_address || '').trim().toLowerCase(),
    String(row?.mimir_key || '').trim().toUpperCase(),
    String(row?.vote_value ?? '').trim()
  ].join(':');
}

export function canonicalReservePaymentKey(row) {
  let amountBase = String(row?.amount_base || '0').trim();
  try {
    amountBase = BigInt(amountBase).toString();
  } catch {
    // Invalid rows are rejected by the domain parser; retain a deterministic key.
  }
  return [
    'reserve-payment',
    String(row?.height || ''),
    String(row?.tx_id || '').trim().toUpperCase(),
    amountBase,
    String(row?.sender || '').trim().toLowerCase(),
    String(row?.recipient || '').trim().toLowerCase(),
    String(row?.memo || '').trim().toUpperCase()
  ].join(':');
}

export function eventProvenanceFields({ canonicalKey, source, observedAt, existingSource }) {
  const timestamp = safeIso(observedAt);
  return {
    canonical_key: String(canonicalKey || ''),
    preferred_source: choosePreferredSource(existingSource, source),
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    schema_version: EVENT_SCHEMA_VERSION
  };
}

export async function enrichEventRows(_client, options) {
  const rows = Array.isArray(options?.rows) ? options.rows : [];
  if (rows.length === 0) return [];
  const canonicalKey = options.canonicalKey;
  const source = options.source;
  const observedAt = options.observedAt;
  return rows.map((row) => {
    const key = String(canonicalKey(row) || '');
    const sourceName = safeSource(source(row));
    const timestamp = safeIso(observedAt(row));
    return {
      ...row,
      ...eventProvenanceFields({
        canonicalKey: key,
        source: sourceName,
        observedAt: timestamp
      })
    };
  });
}

function eventTimestamp(row) {
  const value = Date.parse(row?.last_seen_at || row?.observed_at || row?.updated_at || 0);
  return Number.isFinite(value) ? value : 0;
}

export function selectPreferredEventRows(rows) {
  const selected = new Map();
  for (const row of rows || []) {
    const key = String(row?.canonical_key || '');
    if (!key) continue;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, row);
      continue;
    }

    const currentRank = eventSourceRank(current.preferred_source);
    const incomingRank = eventSourceRank(row.preferred_source);
    if (
      incomingRank > currentRank
      || (incomingRank === currentRank && eventTimestamp(row) >= eventTimestamp(current))
    ) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

export async function withEventTransaction(client, callback) {
  await client.query('begin');
  try {
    const result = await callback();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

export async function recordEventSourceObservations(client, options) {
  const rows = Array.isArray(options?.rows) ? options.rows : [];
  if (rows.length === 0) return;
  const byIdentity = new Map();
  for (const row of rows) {
    const observation = {
    domain: options.domain,
    canonical_key: String(row.canonical_key || ''),
    source: safeSource(options.source(row)),
    source_event_key: String(options.sourceEventKey(row) || ''),
    first_observed_at: safeIso(row.first_seen_at),
    last_observed_at: safeIso(row.last_seen_at),
    raw_reference: options.rawReference?.(row) || {},
    schema_version: Number(row.schema_version || EVENT_SCHEMA_VERSION)
    };
    if (!observation.canonical_key) continue;
    const identity = [
      observation.domain,
      observation.canonical_key,
      observation.source,
      observation.source_event_key
    ].join('\u0000');
    const previous = byIdentity.get(identity);
    if (previous) {
      observation.first_observed_at = safeIso(
        Math.min(Date.parse(previous.first_observed_at), Date.parse(observation.first_observed_at))
      );
      observation.last_observed_at = safeIso(
        Math.max(Date.parse(previous.last_observed_at), Date.parse(observation.last_observed_at))
      );
    }
    byIdentity.set(identity, observation);
  }
  const observations = [...byIdentity.values()];

  await upsertRows(client, 'event_source_observations', observations, {
    conflictColumns: ['domain', 'canonical_key', 'source', 'source_event_key'],
    updateColumns: ['first_observed_at', 'last_observed_at', 'raw_reference', 'schema_version'],
    updateStrategies: {
      first_observed_at: 'least',
      last_observed_at: 'greatest',
      schema_version: 'greatest'
    },
    jsonColumns: ['raw_reference']
  });
}
