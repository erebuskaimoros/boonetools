import { booneToolsApi } from '../api/boonetools.js';

export async function fetchBurnTracker(options = {}) {
  return booneToolsApi.get('/burn-tracker', {
    cache: 'no-store',
    errorMessage: ({ response }) => `Burn Tracker history failed (${response.status})`,
    challengeMessage: 'Burn Tracker backend returned a challenge response'
  });
}
