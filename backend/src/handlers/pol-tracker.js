import { error, json } from '../lib/http.js';
import { createReadModelEtag } from '../shared/read-models.js';
import { getPolTrackerReadModel } from '../shared/pol-tracker.js';

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

  const stale = Boolean(model.stale);
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
    ...(model.payload || {}),
    stale,
    warnings: [...new Set([
      ...(Array.isArray(model.payload?.warnings) ? model.payload.warnings : []),
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
