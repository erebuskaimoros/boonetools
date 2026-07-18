import { error, json } from '../lib/http.js';
import { createReadModelEtag } from '../shared/read-models.js';
import { getTreasurySnapshotReadModel } from '../shared/treasury-snapshot.js';

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

function responseEtag(model) {
  return createReadModelEtag({ etag: model.etag, stale: model.stale });
}

export async function handleTreasurySnapshot(request, _url, options = {}) {
  const model = await (options.getReadModel || getTreasurySnapshotReadModel)();
  if (!model) {
    return error('Treasury snapshot is not available yet', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '30'
    });
  }

  const etag = responseEtag(model);
  const headers = {
    'Cache-Control': model.stale
      ? 'public, max-age=15, stale-if-error=3600'
      : 'public, max-age=60, stale-while-revalidate=240, stale-if-error=3600',
    ETag: etag,
    'Last-Modified': model.publishedAt || model.generatedAt,
    'X-Boone-Age': String(model.ageSeconds ?? 0),
    'X-Boone-Cache': model.stale ? 'stale' : 'hit'
  };
  if (etagMatches(request, etag)) return { status: 304, body: null, headers };

  const { control: _control, ...publicPayload } = model.payload || {};
  const warnings = [...new Set([
    ...(Array.isArray(publicPayload.warnings) ? publicPayload.warnings : []),
    ...(model.stale ? ['Serving the last successful Treasury snapshot'] : [])
  ])];
  return json({
    ...publicPayload,
    stale: Boolean(publicPayload.stale || model.stale),
    warnings,
    read_model: {
      key: model.key,
      schema_version: model.schemaVersion,
      generated_at: model.generatedAt,
      fresh_until: model.freshUntil,
      published_at: model.publishedAt,
      stale: model.stale
    }
  }, 200, headers);
}
