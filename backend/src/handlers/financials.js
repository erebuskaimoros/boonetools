import { FINANCIALS_RANGES } from '../../../shared/financials/model.js';
import { error, json } from '../lib/http.js';
import { createReadModelEtag, getReadModel } from '../shared/read-models.js';
import { ageFinancialsPayload, financialsModelKey } from '../shared/financials-read-model.js';

export async function handleFinancials(_request, url, options = {}) {
  const range = url.searchParams.get('range') || '30d';
  if (!FINANCIALS_RANGES.some((item) => item.id === range)) return error('Range must be 30d, 90d, 1y, or all', 400);
  const model = await (options.getReadModel || getReadModel)(financialsModelKey(range));
  if (!model?.payload?.points?.length) return error('Financials is warming', 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  const now = options.now?.() ?? Date.now();
  const aged = ageFinancialsPayload(model.payload, now);
  const liveDelayed = Boolean(aged.live?.stale) || Boolean(aged.live?.through && now - Date.parse(aged.live.through) > 600_000);
  const stale = Boolean(model.stale || aged.stale || liveDelayed);
  const payload = { ...aged, stale,
    live: { ...aged.live, stale: Boolean(model.stale || liveDelayed) },
    read_model: { key: model.key, generated_at: model.generatedAt, source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil, stale }
  };
  return json(payload, 200, {
    'Cache-Control': 'public, max-age=15, must-revalidate',
    ETag: createReadModelEtag(payload),
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0),
    'X-Boone-Read-Model-Stale': stale ? '1' : '0'
  });
}
