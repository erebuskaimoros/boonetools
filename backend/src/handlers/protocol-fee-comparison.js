import { ageComparisonPayload, COMPARISON_MODEL_KEY, hasComparisonData } from '../../../shared/protocol-fee-comparison/model.js';
import { error, json } from '../lib/http.js';
import { createReadModelEtag, getReadModel } from '../shared/read-models.js';

export async function handleProtocolFeeComparison(_request, _url, options = {}) {
  const model = await (options.getReadModel || getReadModel)(COMPARISON_MODEL_KEY);
  if (!hasComparisonData(model?.payload)) return error('Monthly comparison is warming; no estimated values substituted.', 503, { 'Cache-Control': 'no-store', 'Retry-After': '60' });
  const payload = ageComparisonPayload({ ...model.payload, stale: Boolean(model.stale || model.payload.stale) }, options.now?.() ?? Date.now());
  return json(payload, 200, { 'Cache-Control': 'public, max-age=60, must-revalidate', ETag: createReadModelEtag(payload),
    'X-Boone-Read-Model-Stale': payload.stale ? '1' : '0' });
}
