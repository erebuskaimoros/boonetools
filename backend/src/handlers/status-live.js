import { error, json } from '../lib/http.js';
import { createReadModelEtag } from '../shared/read-models.js';
import { getStatusLiveReadModel } from '../shared/status-live.js';

function headerValue(request, name) {
  const normalized = String(name || '').toLowerCase();
  return String(
    request?.headers?.[normalized]
      ?? request?.headers?.get?.(name)
      ?? ''
  );
}

function etagMatches(request, etag) {
  return headerValue(request, 'if-none-match')
    .split(',')
    .map((value) => value.trim())
    .includes(etag);
}

export async function handleStatusLive(request, _url, options = {}) {
  const model = await (options.getReadModel || getStatusLiveReadModel)();
  if (!model) {
    return error('Live status snapshot is not available yet', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '5'
    });
  }

  const stale = Boolean(model.payload?.stale || model.stale);
  const etag = createReadModelEtag({ etag: model.etag, stale });
  const headers = {
    'Cache-Control': stale
      ? 'public, max-age=2, stale-if-error=60'
      : 'public, max-age=5, stale-while-revalidate=5, stale-if-error=60',
    ETag: etag,
    'Last-Modified': model.publishedAt || model.generatedAt,
    'X-Boone-Read-Model-Stale': stale ? '1' : '0',
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0)
  };
  if (etagMatches(request, etag)) return { status: 304, body: null, headers };

  const warnings = [...new Set([
    ...(Array.isArray(model.payload?.warnings) ? model.payload.warnings : []),
    ...(stale ? ['Serving the last successful live status snapshot'] : [])
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
