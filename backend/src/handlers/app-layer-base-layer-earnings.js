import { json } from '../lib/http.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { getReadModel } from '../shared/read-models.js';

export async function handleAppLayerBaseLayerEarnings(request) {
  const model = await getReadModel(ANALYTICS_READ_MODEL_KEYS.appLayerBaseLayerEarnings);
  if (!model) {
    return json({
      error: 'App Layer Base Layer earnings snapshot is warming',
      retryable: true,
      model_key: ANALYTICS_READ_MODEL_KEYS.appLayerBaseLayerEarnings
    }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  }

  const stale = Boolean(model.stale || model.payload?.meta?.stale);
  const headers = {
    'Cache-Control': stale ? 'public, max-age=15' : 'public, max-age=60',
    ...(!stale ? { ETag: model.etag } : {}),
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0)
  };
  if (!stale && String(request?.headers?.['if-none-match'] || '') === model.etag) {
    return json({}, 304, headers);
  }
  return json(stale ? {
    ...model.payload,
    meta: {
      ...(model.payload?.meta || {}),
      stale: true,
      warning: model.payload?.meta?.warning || 'Serving the last successful Base Layer earnings snapshot'
    }
  } : model.payload, 200, headers);
}
