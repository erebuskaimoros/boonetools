import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComparisonPayload } from '../src/protocol-fee-comparison/collector.js';
import { COMPARISON_MODEL_KEY, COMPARISON_REFRESH_MS, hasComparisonData, nextDay } from '../../shared/protocol-fee-comparison/model.js';
import { createReadModelEtag } from '../src/shared/read-models.js';

// Offline bootstrap: no database connection and no provider requests. The SQL
// can run against the existing schema BEFORE deploying/enabling the collector.
export function prepareComparisonSeed(saved, { now = Date.now() } = {}) {
  const { cache, payload: previous } = saved || {};
  if (cache?.version !== 1 || !cache.days || !cache.boundaries || Array.isArray(cache.days)) {
    throw new Error('Expected a version-1 local collector snapshot');
  }
  const observed = Date.parse(previous?.asOf);
  if (!Number.isFinite(observed) || observed > now) throw new Error('Missing or future observation timestamp');
  if (!Array.isArray(previous.errors) || previous.errors.some(error => typeof error !== 'string')) {
    throw new Error('Invalid source errors');
  }
  // Rebuild using the snapshot observation time, never pretending a local
  // bootstrap just fetched fresh data. Keep missing months and source warnings.
  const payload = buildComparisonPayload(cache, { now: observed, errors: previous.errors });
  if (!hasComparisonData(payload)) throw new Error('Snapshot has no aligned comparison data');
  const serialized = JSON.stringify(cache);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  return { cache, payload, sha256, summary: {
    asOf: payload.asOf, fromDay: payload.fromDay, throughDay: payload.throughDay,
    days: Object.keys(cache.days).length, boundaries: Object.keys(cache.boundaries).length,
    nearEpochs: Object.keys(cache.nearEpochs || {}).length,
    flipDays: Object.values(cache.days).filter(row => row.flipIssuance?.atomic != null).length,
    months: payload.months.length, sha256
  } };
}

// Hex-encoded UTF-8 avoids SQL/string/psql escaping ambiguities in cached text.
const sqlText = value => `convert_from(decode('${Buffer.from(String(value)).toString('hex')}', 'hex'), 'UTF8')`;
export function comparisonSeedSql(seed) {
  const { cache, payload, sha256 } = seed;
  const observed = Date.parse(payload.asOf);
  const key = sqlText(COMPARISON_MODEL_KEY);
  const metadata = sqlText(JSON.stringify({ bootstrap: 'verified-local-cache', cacheSha256: sha256 }));
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
DO $seed_guard$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('boonetools:protocol-fee-comparison')) THEN
    RAISE EXCEPTION 'Comparison collector is running; stop it before seeding';
  END IF;
  IF EXISTS (SELECT 1 FROM source_observations WHERE namespace = ${key} AND identity = 'collector')
     OR EXISTS (SELECT 1 FROM api_read_models WHERE model_key = ${key}) THEN
    RAISE EXCEPTION 'Comparison data already exists; bootstrap refuses to overwrite production';
  END IF;
END
$seed_guard$;
INSERT INTO source_observations (namespace, identity, payload_json, source, observed_at, expires_at, metadata_json)
VALUES (${key}, 'collector', ${sqlText(JSON.stringify(cache))}::jsonb,
  'midgard+llama+fastnear+chainflip-archive', ${sqlText(payload.asOf)}::timestamptz,
  ${sqlText(new Date(observed + COMPARISON_REFRESH_MS).toISOString())}::timestamptz, ${metadata}::jsonb);
INSERT INTO api_read_models (model_key, schema_version, payload_json, etag, generated_at, source_updated_at, fresh_until, metadata_json)
VALUES (${key}, 1, ${sqlText(JSON.stringify(payload))}::jsonb, ${sqlText(createReadModelEtag(payload))},
  ${sqlText(payload.asOf)}::timestamptz, ${sqlText(`${nextDay(payload.throughDay)}T00:00:00Z`)}::timestamptz,
  ${sqlText(new Date(observed + COMPARISON_REFRESH_MS * 2).toISOString())}::timestamptz, ${metadata}::jsonb);
COMMIT;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, snapshot, ...extra] = process.argv.slice(2);
  if (!['--check', '--sql'].includes(mode) || !snapshot || extra.length) {
    throw new Error('Usage: node backend/scripts/seed-protocol-fee-comparison.mjs --check|--sql SNAPSHOT.json');
  }
  const seed = prepareComparisonSeed(JSON.parse(await readFile(snapshot, 'utf8')));
  process.stdout.write(mode === '--sql' ? comparisonSeedSql(seed) : `${JSON.stringify(seed.summary, null, 2)}\n`);
}
