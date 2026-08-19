import { booneToolsApi } from '../api/boonetools.js';

export async function fetchPolTracker(options = {}) {
  return booneToolsApi.get('/pol-tracker', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    errorMessage: ({ response }) => `POL Tracker history failed (${response.status})`,
    challengeMessage: 'POL Tracker backend returned a challenge response'
  });
}
