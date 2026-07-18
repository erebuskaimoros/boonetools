import { createHash } from 'node:crypto';
import { TtlSingleFlightCache } from '../lib/ttl-cache.js';

const DEFAULT_TTL_MS = 60_000;
const REQUEST_CACHE_TTL_MS = 3_000;
const requestRowCache = new TtlSingleFlightCache({ ttlMs: REQUEST_CACHE_TTL_MS });

async function defaultQuery(...args) {
  const { query } = await import('../db/pool.js');
  return query(...args);
}

function database(options = {}) {
  return options.client || { query: options.query || defaultQuery };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function timestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function requireModelKey(modelKey) {
  const normalized = String(modelKey || '').trim();
  if (!normalized) throw new Error('Read-model key is required');
  return normalized;
}

export function serializeReadModelPayload(payload) {
  if (payload == null || typeof payload !== 'object') {
    throw new Error('Read-model payload must be an object or array');
  }
  return JSON.stringify(payload);
}

export function createReadModelEtag(payload) {
  const serialized = typeof payload === 'string'
    ? payload
    : serializeReadModelPayload(payload);
  return `"${createHash('sha256').update(serialized).digest('base64url')}"`;
}

export function normalizeReadModelRow(row, options = {}) {
  if (!row) return null;
  const nowMs = Number(options.nowMs ?? Date.now());
  const generatedAt = timestamp(row.generated_at);
  const freshUntil = timestamp(row.fresh_until);
  const generatedAtMs = Date.parse(generatedAt || '');
  const freshUntilMs = Date.parse(freshUntil || '');

  return {
    key: String(row.model_key || ''),
    schemaVersion: Number(row.schema_version) || 1,
    payload: row.payload_json,
    etag: String(row.etag || ''),
    generatedAt,
    sourceUpdatedAt: timestamp(row.source_updated_at),
    freshUntil,
    publishedAt: timestamp(row.published_at),
    runId: row.run_id == null ? null : String(row.run_id),
    metadata: objectValue(row.metadata_json),
    stale: !Number.isFinite(freshUntilMs) || freshUntilMs <= nowMs,
    ageSeconds: Number.isFinite(generatedAtMs)
      ? Math.max(0, Math.floor((nowMs - generatedAtMs) / 1000))
      : null
  };
}

export async function getReadModel(modelKey, options = {}) {
  const key = requireModelKey(modelKey);
  const loadRow = async () => {
    const { rows } = await database(options).query(
      `select model_key, schema_version, payload_json, etag, generated_at,
              source_updated_at, fresh_until, published_at, run_id, metadata_json
       from api_read_models
       where model_key = $1
       limit 1`,
      [key]
    );
    return rows[0] || null;
  };
  // Scheduler/client reads bypass this cache. Public handler reads share a
  // short single-flight row cache, while age and stale state are recomputed for
  // every request below.
  const row = options.client || options.cache === false
    ? await loadRow()
    : await requestRowCache.getOrLoad(key, loadRow);
  const model = normalizeReadModelRow(row, options);
  if (model?.stale && options.allowStale === false) return null;
  return model;
}

export async function publishReadModel(modelKey, payload, options = {}) {
  const key = requireModelKey(modelKey);
  const serialized = serializeReadModelPayload(payload);
  const generatedAt = timestamp(options.generatedAt, new Date().toISOString());
  const ttlMs = Math.max(1000, Math.trunc(Number(options.ttlMs) || DEFAULT_TTL_MS));
  const freshUntil = timestamp(
    options.freshUntil,
    new Date(Date.parse(generatedAt) + ttlMs).toISOString()
  );
  const sourceUpdatedAt = timestamp(options.sourceUpdatedAt);
  const schemaVersion = Math.max(1, Math.trunc(Number(options.schemaVersion) || 1));
  const etag = createReadModelEtag(serialized);
  const metadata = objectValue(options.metadata);
  const client = database(options);
  const { rows } = await client.query(
    `insert into api_read_models (
       model_key, schema_version, payload_json, etag, generated_at,
       source_updated_at, fresh_until, published_at, run_id, metadata_json
     ) values ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9)
     on conflict (model_key)
     do update set
       schema_version = excluded.schema_version,
       payload_json = excluded.payload_json,
       etag = excluded.etag,
       generated_at = excluded.generated_at,
       source_updated_at = excluded.source_updated_at,
       fresh_until = excluded.fresh_until,
       published_at = now(),
       run_id = excluded.run_id,
       metadata_json = excluded.metadata_json
     returning model_key, schema_version, payload_json, etag, generated_at,
               source_updated_at, fresh_until, published_at, run_id, metadata_json`,
    [
      key,
      schemaVersion,
      payload,
      etag,
      generatedAt,
      sourceUpdatedAt,
      freshUntil,
      options.runId || null,
      metadata
    ]
  );

  requestRowCache.delete(key);

  return normalizeReadModelRow(rows[0], options);
}

export function clearReadModelRequestCache() {
  requestRowCache.clear();
}

export async function startReadModelRun(modelKey, options = {}) {
  const key = requireModelKey(modelKey);
  const startedAt = timestamp(options.startedAt, new Date().toISOString());
  const { rows } = await database(options).query(
    `with pruned as (
       delete from api_read_model_runs as runs
       where runs.started_at < now() - interval '30 days'
         and not exists (
           select 1 from api_read_models as models where models.run_id = runs.id
         )
     )
     insert into api_read_model_runs (model_key, started_at, status, stats_json)
     values ($1, $2, 'running', $3)
     returning id`,
    [key, startedAt, objectValue(options.stats)]
  );
  return String(rows[0].id);
}

export async function completeReadModelRun(runId, options = {}) {
  await database(options).query(
    `update api_read_model_runs
     set finished_at = $2,
         status = $3,
         duration_ms = $4,
         source_watermark = $5,
         output_bytes = $6,
         error = $7,
         stats_json = $8
     where id = $1`,
    [
      runId,
      timestamp(options.finishedAt, new Date().toISOString()),
      options.status,
      Math.max(0, Math.trunc(Number(options.durationMs) || 0)),
      timestamp(options.sourceWatermark),
      options.outputBytes == null ? null : Math.max(0, Math.trunc(Number(options.outputBytes) || 0)),
      options.error || null,
      objectValue(options.stats)
    ]
  );
}

export async function buildAndPublishReadModel(options = {}) {
  const key = requireModelKey(options.modelKey);
  if (typeof options.build !== 'function') throw new Error('Read-model build function is required');
  const client = database(options);
  const now = options.now || (() => new Date());
  const startedAt = now();
  const startedMs = startedAt.getTime();
  const runId = await startReadModelRun(key, { client, startedAt, stats: options.initialStats });

  try {
    const result = await options.build(client);
    const payload = result?.payload ?? result;
    const serialized = serializeReadModelPayload(payload);
    const generatedAt = timestamp(result?.generatedAt, now().toISOString());
    const sourceUpdatedAt = timestamp(result?.sourceUpdatedAt);
    const published = await publishReadModel(key, payload, {
      client,
      runId,
      ttlMs: options.ttlMs,
      schemaVersion: options.schemaVersion,
      generatedAt,
      sourceUpdatedAt,
      metadata: result?.metadata
    });
    const durationMs = Math.max(0, now().getTime() - startedMs);
    await completeReadModelRun(runId, {
      client,
      status: 'success',
      durationMs,
      sourceWatermark: sourceUpdatedAt,
      outputBytes: Buffer.byteLength(serialized),
      stats: result?.stats
    });
    return { ok: true, runId, model: published };
  } catch (error) {
    const durationMs = Math.max(0, now().getTime() - startedMs);
    await completeReadModelRun(runId, {
      client,
      status: 'error',
      durationMs,
      error: error?.message || String(error),
      stats: { error: error?.message || String(error) }
    }).catch(() => {});
    throw error;
  }
}
