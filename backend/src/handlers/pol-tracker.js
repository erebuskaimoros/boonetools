import { error, json } from '../lib/http.js';
import { config } from '../lib/config.js';
import { createReadModelEtag } from '../shared/read-models.js';
import { getPolTrackerReadModel } from '../shared/pol-tracker.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dayString(value) {
  const normalized = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function resolvedNow(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const parsed = resolved instanceof Date ? resolved : new Date(resolved || Date.now());
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function expectedSourceDay(now, headLagDays = config.polTrackerHeadLagDays) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lagDays = Math.max(0, Math.trunc(Number(headLagDays)) || 0);
  return new Date(midnight - ((lagDays + 1) * DAY_MS)).toISOString().slice(0, 10);
}

function lagDays(targetDay, sourceDay) {
  const target = Date.parse(`${dayString(targetDay)}T00:00:00Z`);
  const source = Date.parse(`${dayString(sourceDay)}T00:00:00Z`);
  if (!Number.isFinite(target) || !Number.isFinite(source)) return 0;
  return Math.max(0, Math.round((target - source) / DAY_MS));
}

function sourceFreshness(payload = {}, options = {}) {
  const targetDay = expectedSourceDay(
    resolvedNow(options.now),
    options.headLagDays ?? config.polTrackerHeadLagDays
  );
  const coverage = payload.coverage && typeof payload.coverage === 'object'
    ? payload.coverage
    : null;
  const endDay = dayString(payload.end_date)
    || dayString(coverage?.last_day)
    || dayString(payload.latest?.day);
  const latestDay = dayString(coverage?.last_day)
    || dayString(payload.latest?.day)
    || endDay;
  const scopeLagDays = lagDays(targetDay, endDay);
  const sourceLagDays = Math.max(scopeLagDays, lagDays(targetDay, latestDay));
  const effectiveCoverage = coverage ? {
    ...coverage,
    expected_days: Math.max(0, Number(coverage.expected_days) || 0) + scopeLagDays,
    missing_days: Math.max(0, Number(coverage.missing_days) || 0) + scopeLagDays
  } : coverage;
  return {
    targetDay,
    sourceLagDays,
    stale: Boolean((endDay || latestDay) && sourceLagDays > 0),
    coverage: effectiveCoverage
  };
}

function headerValue(request, name) {
  const normalized = String(name || '').toLowerCase();
  return String(request?.headers?.[normalized] ?? request?.headers?.get?.(name) ?? '');
}
function etagMatches(request, etag) {
  return headerValue(request, 'if-none-match')
    .split(',')
    .map((value) => value.trim())
    .includes(etag);
}

export async function handlePolTracker(request, _url, options = {}) {
  const model = await (options.getReadModel || getPolTrackerReadModel)();
  if (!model) {
    return error('POL Tracker history is warming', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '300'
    });
  }

  const payload = model.payload || {};
  const freshness = sourceFreshness(payload, options);
  const stale = Boolean(model.stale || freshness.stale);
  const etag = createReadModelEtag({ etag: model.etag, stale });
  const headers = {
    'Cache-Control': stale
      ? 'public, max-age=60, stale-if-error=86400'
      : 'public, max-age=300, stale-while-revalidate=3600, stale-if-error=86400',
    ETag: etag,
    'Last-Modified': model.publishedAt || model.generatedAt,
    'X-Boone-Age': String(model.ageSeconds ?? 0),
    'X-Boone-Cache': stale ? 'stale' : 'hit'
  };
  if (etagMatches(request, etag)) return { status: 304, body: null, headers };

  return json({
    ...payload,
    target_end_date: freshness.targetDay,
    ...(freshness.coverage ? { coverage: freshness.coverage } : {}),
    stale,
    warnings: [...new Set([
      ...(Array.isArray(payload.warnings) ? payload.warnings : []),
      ...(freshness.sourceLagDays > 0 ? [
        `POL Tracker source is ${freshness.sourceLagDays} ${freshness.sourceLagDays === 1 ? 'day' : 'days'} behind expected target ${freshness.targetDay}`
      ] : []),
      ...(stale ? ['Serving the last successful POL Tracker read model'] : [])
    ])],
    read_model: {
      key: model.key,
      schema_version: model.schemaVersion,
      generated_at: model.generatedAt,
      source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil,
      published_at: model.publishedAt,
      stale
    }
  }, 200, headers);
}
