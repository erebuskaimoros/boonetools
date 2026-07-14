import { json } from '../lib/http.js';
import { getRujiraBaseLayerEarningsDashboardPayload } from '../shared/rujira-base-layer-earnings.js';

export async function handleAppLayerBaseLayerEarnings() {
  const payload = await getRujiraBaseLayerEarningsDashboardPayload();
  return json(payload, 200, {
    'Cache-Control': payload.meta?.stale ? 'public, max-age=15' : 'public, max-age=60'
  });
}
