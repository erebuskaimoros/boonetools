import { query } from '../db/pool.js';

export async function getCachedResponse(cacheKey, options = {}) {
  const allowStale = Boolean(options.allowStale);
  const { rows } = await query(
    `select payload_json, fetched_at, expires_at
     from api_response_cache
     where cache_key = $1
     limit 1`,
    [cacheKey]
  );

  const row = rows[0] || null;
  if (!row) {
    return null;
  }

  const expiresAtMs = Date.parse(String(row.expires_at || ''));
  const fresh = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
  if (!fresh && !allowStale) {
    return null;
  }

  return {
    payload: row.payload_json,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    stale: !fresh
  };
}

export async function setCachedResponse(cacheKey, payload, ttlMs) {
  const normalizedTtlMs = Math.max(1000, Math.trunc(Number(ttlMs) || 0));
  const expiresAt = new Date(Date.now() + normalizedTtlMs).toISOString();

  await query(
    `insert into api_response_cache (cache_key, payload_json, fetched_at, expires_at)
     values ($1, $2, now(), $3)
     on conflict (cache_key)
     do update set
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    [cacheKey, payload, expiresAt]
  );
}
