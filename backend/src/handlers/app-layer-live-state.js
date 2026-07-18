import { json } from '../lib/http.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { getReadModel } from '../shared/read-models.js';

export async function handleAppLayerLiveState(request) {
  const model = await getReadModel(ANALYTICS_READ_MODEL_KEYS.appLayerLiveState);
  if (!model) {
    return json({
      error: 'App Layer live-state snapshot is warming',
      retryable: true,
      model_key: ANALYTICS_READ_MODEL_KEYS.appLayerLiveState
    }, 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '30'
    });
  }
  const headers = {
    'Cache-Control': model.stale ? 'public, max-age=15' : 'public, max-age=30',
    ...(!model.stale ? { ETag: model.etag } : {}),
    'X-Boone-Cache': model.stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0)
  };
  if (!model.stale && String(request?.headers?.['if-none-match'] || '') === model.etag) {
    return json({}, 304, headers);
  }
  return json(model.stale ? {
    ...model.payload,
    stale: true,
    warning: model.payload?.warning || 'Serving the last successful App Layer live-state snapshot'
  } : model.payload, 200, headers);
}
