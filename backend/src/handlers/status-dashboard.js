import { error, json } from '../lib/http.js';
import { createReadModelEtag } from '../shared/read-models.js';
import { getStatusDashboardReadModel } from '../shared/status-dashboard.js';

function headerValue(request, name) {
  const normalized = String(name || '').toLowerCase();
  return String(
    request?.headers?.[normalized]
      ?? request?.headers?.get?.(name)
      ?? ''
  );
}

function etagMatches(request, etag) {
  const candidate = headerValue(request, 'if-none-match');
  return candidate.split(',').map((value) => value.trim()).includes(etag);
}

function responseEtag(model, stale) {
  return createReadModelEtag({
    etag: model.etag,
    stale
  });
}

export async function handleStatusDashboard(request, _url, options = {}) {
  const model = await (options.getReadModel || getStatusDashboardReadModel)();
  if (!model) {
    return error('Status dashboard snapshot is not available yet', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '30'
    });
  }

  const stale = Boolean(model.payload?.stale || model.stale);
  const etag = responseEtag(model, stale);
  const headers = {
    'Cache-Control': stale
      ? 'public, max-age=10, stale-if-error=300'
      : 'public, max-age=30, stale-while-revalidate=30, stale-if-error=300',
    ETag: etag,
    'Last-Modified': model.publishedAt || model.generatedAt,
    'X-Boone-Read-Model-Stale': stale ? '1' : '0',
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0)
  };
  if (etagMatches(request, etag)) {
    return { status: 304, body: null, headers };
  }

  const warnings = [...new Set([
    ...(Array.isArray(model.payload?.warnings) ? model.payload.warnings : []),
    ...(stale ? ['Serving the last successful status dashboard snapshot'] : [])
  ])];
  return json({
    ...model.payload,
    stale,
    warnings,
    read_model: {
      key: model.key,
      schema_version: model.schemaVersion,
      generated_at: model.generatedAt,
      source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil,
      published_at: model.publishedAt,
      stale: model.stale
    }
  }, 200, headers);
}
