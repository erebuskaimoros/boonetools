import { json } from '../lib/http.js';
import { getAppLayerLiveState } from '../shared/app-layer-live-state.js';

export async function handleAppLayerLiveState() {
  const payload = await getAppLayerLiveState();
  return json(payload, 200, {
    'Cache-Control': payload.stale ? 'public, max-age=15' : 'public, max-age=30'
  });
}
