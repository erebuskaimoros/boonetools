import { json } from '../lib/http.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { getReadModel } from '../shared/read-models.js';

export const WASM_ARB_ECONOMICS_READ_MODEL_KEY =
  ANALYTICS_READ_MODEL_KEYS.wasmArbEconomics;

export async function handleWasmArbEconomics(request) {
  const model = await getReadModel(WASM_ARB_ECONOMICS_READ_MODEL_KEY);
  if (!model) {
    return json({
      error: 'Wasm arb economics snapshot is warming',
      retryable: true,
      model_key: WASM_ARB_ECONOMICS_READ_MODEL_KEY
    }, 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '60'
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
      warning: model.payload?.meta?.warning
        || 'Serving the last successful Wasm arb economics snapshot'
    }
  } : model.payload, 200, headers);
}
