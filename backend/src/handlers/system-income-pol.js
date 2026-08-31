import { query } from '../db/pool.js';
import { error, json } from '../lib/http.js';
import { createReadModelEtag } from '../shared/read-models.js';
import {
  applySystemIncomePolLiveOverlay,
  getSystemIncomePolReadModel
} from '../shared/system-income-pol.js';
import { loadSystemIncomePolLiveOverlay } from '../shared/system-income-pol-store.js';

function headerValue(request, name) {
  const normalized = String(name || '').toLowerCase();
  return String(request?.headers?.[normalized] ?? request?.headers?.get?.(name) ?? '');
}

export async function handleSystemIncomePol(request, _url, options = {}) {
  const model = await (options.getReadModel || getSystemIncomePolReadModel)();
  if (!model) {
    return error('System Income POL is warming', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '120'
    });
  }
  const getOverlay = options.getLiveOverlay
    || ((since) => loadSystemIncomePolLiveOverlay({ query }, since));
  const overlay = await getOverlay(model.payload?.live?.through_height || 0);
  const payload = applySystemIncomePolLiveOverlay(model.payload || {}, overlay);
  const stale = Boolean(model.stale);
  const etag = createReadModelEtag({
    etag: model.etag,
    live: payload.live,
    summary: payload.summary,
    stale
  });
  const headers = {
    'Cache-Control': 'no-store',
    ETag: etag,
    'Last-Modified': payload.live?.through_time || model.publishedAt || model.generatedAt,
    'X-Boone-Age': String(model.ageSeconds ?? 0),
    'X-Boone-Cache': stale ? 'stale' : payload.live?.through_height ? 'live-overlay' : 'hit'
  };
  const matches = headerValue(request, 'if-none-match')
    .split(',')
    .map((value) => value.trim())
    .includes(etag);
  if (matches) return { status: 304, body: null, headers };
  return json({
    ...payload,
    stale,
    warnings: [...new Set([
      ...(Array.isArray(payload.warnings) ? payload.warnings : []),
      ...(stale ? ['Serving the last successful System Income POL read model'] : [])
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
