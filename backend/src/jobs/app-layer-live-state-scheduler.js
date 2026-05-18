import { refreshAppLayerLiveState } from '../shared/app-layer-live-state.js';

export async function runAppLayerLiveStateScheduler() {
  const result = await refreshAppLayerLiveState();
  return {
    ok: Boolean(result?.ok),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || '',
    refreshed: Boolean(result?.refreshed),
    as_of: result?.snapshot?.as_of || null,
    warning: result?.snapshot?.warning || ''
  };
}
