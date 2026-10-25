import { FINANCIALS_RANGES } from '../../../shared/financials/model.js';
import { error, json } from '../lib/http.js';
import { createReadModelEtag, getReadModel } from '../shared/read-models.js';
import { ageFinancialsPayload, financialsModelKey } from '../shared/financials-read-model.js';
import { financialDetailDay, readFinancialDay } from '../shared/financials-day-detail.js';
import { financialHourlyWindow, sliceFinancialHourlyPayload, FINANCIALS_HOURLY_MODEL_KEY } from '../../../shared/financials/hourly.js';

export async function handleFinancials(_request, url, options = {}) {
  if (url.searchParams.has('bucket') && !['hour', 'day'].includes(url.searchParams.get('bucket'))) return error('Bucket must be hour or day', 400);
  if (url.searchParams.get('bucket') === 'hour') {
    if (url.searchParams.has('day')) return error('Day details use daily buckets', 400);
    const range = url.searchParams.get('range') || '24h';
    const now = options.now?.() ?? Date.now();
    try { financialHourlyWindow(range, now); } catch (failure) { return error(failure.message, 400); }
    const model = await (options.getReadModel || getReadModel)(FINANCIALS_HOURLY_MODEL_KEY);
    if (!model?.payload?.points?.length) return error('Hourly Financials is warming', 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
    const payload = sliceFinancialHourlyPayload({ ...model.payload, stale: Boolean(model.stale || model.payload.stale) }, range, now);
    return json(payload, 200, { 'Cache-Control': 'public, max-age=15, must-revalidate', ETag: createReadModelEtag(payload),
      'X-Boone-Cache': payload.stale ? 'read-model-stale' : 'read-model', 'X-Boone-Read-Model-Stale': payload.stale ? '1' : '0' });
  }
  if (url.searchParams.has('day')) {
    const day = url.searchParams.get('day');
    try { financialDetailDay(day, options.now?.() ?? Date.now()); }
    catch (failure) { return error(failure.message, 400); }
    const detail = await (options.readDay || readFinancialDay)(day);
    return json(detail, 200, { 'Cache-Control': 'no-store' });
  }
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
