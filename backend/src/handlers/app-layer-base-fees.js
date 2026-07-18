import { json } from '../lib/http.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { getReadModel } from '../shared/read-models.js';
import { getRujiraBaseFeesDashboardPayload } from '../shared/rujira-base-fees.js';

export const APP_LAYER_BASE_FEES_READ_MODEL_KEY = ANALYTICS_READ_MODEL_KEYS.appLayerBaseFees;

function isEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

export async function handleAppLayerBaseFees(request, url) {
  const legacy = isEnabled(url?.searchParams?.get('legacy'));
  if (legacy) {
    return json(await getRujiraBaseFeesDashboardPayload(), 200, {
      'Cache-Control': 'private, no-store'
    });
  }

  const model = await getReadModel(APP_LAYER_BASE_FEES_READ_MODEL_KEY);
  if (!model) {
    return json({
      error: 'App Layer base-fee snapshot is warming',
      retryable: true,
      model_key: APP_LAYER_BASE_FEES_READ_MODEL_KEY
    }, 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '30'
    });
  }

  const headers = {
    'Cache-Control': 'public, max-age=60',
    ...(!model.stale ? { ETag: model.etag } : {}),
    'X-Boone-Cache': model.stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0)
  };
  if (!model.stale && String(request?.headers?.['if-none-match'] || '') === model.etag) {
    return json({}, 304, headers);
  }

  return json(model.stale ? {
    ...model.payload,
    meta: {
      ...(model.payload?.meta || {}),
      stale: true,
      warning: model.payload?.meta?.warning || 'Serving the last successful App Layer base-fee snapshot'
    }
  } : model.payload, 200, headers);
}
