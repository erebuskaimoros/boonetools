import { json } from '../lib/http.js';
import { getRujiraBaseFeesDashboardPayload } from '../shared/rujira-base-fees.js';

export async function handleAppLayerBaseFees() {
  const payload = await getRujiraBaseFeesDashboardPayload();
  return json(payload, 200, {
    'Cache-Control': 'public, max-age=60'
  });
}
