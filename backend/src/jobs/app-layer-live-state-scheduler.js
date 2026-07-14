import { refreshAppLayerLiveState } from '../shared/app-layer-live-state.js';
import { refreshRujiraBaseLayerEarnings } from '../shared/rujira-base-layer-earnings.js';

export async function runAppLayerLiveStateScheduler() {
  const result = await refreshAppLayerLiveState();
  let earnings = null;
  let earningsWarning = '';
  if (result?.snapshot) {
    try {
      earnings = await refreshRujiraBaseLayerEarnings(result.snapshot);
    } catch (error) {
      earningsWarning = error.message || String(error);
    }
  }
  return {
    ok: Boolean(result?.ok),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || '',
    refreshed: Boolean(result?.refreshed),
    as_of: result?.snapshot?.as_of || null,
    warning: result?.snapshot?.warning || '',
    earnings,
    earnings_warning: earningsWarning
  };
}
