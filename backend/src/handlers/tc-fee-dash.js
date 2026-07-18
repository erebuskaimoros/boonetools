import { query } from '../db/pool.js';
import { json } from '../lib/http.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { getReadModel } from '../shared/read-models.js';
import { buildTcFeeDashPayload } from '../shared/tc-fee-dash.js';

export const TC_FEE_DASH_READ_MODEL_KEY = ANALYTICS_READ_MODEL_KEYS.tcFeeDash;

function isEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

export async function handleTcFeeDash(request, url) {
  const legacy = isEnabled(url?.searchParams?.get('legacy'));
  if (legacy) {
    const result = await buildTcFeeDashPayload({ query });
    return json(result.payload, 200, { 'Cache-Control': 'private, no-store' });
  }

  const model = await getReadModel(TC_FEE_DASH_READ_MODEL_KEY);
  if (!model) {
    return json({
      error: 'TC Fee Dash snapshot is warming',
      retryable: true,
      model_key: TC_FEE_DASH_READ_MODEL_KEY
    }, 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '60'
    });
  }

  const headers = {
    'Cache-Control': 'public, max-age=300',
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
      warning: model.payload?.meta?.warning || 'Serving the last successful TC Fee Dash snapshot'
    }
  } : model.payload, 200, headers);
}
