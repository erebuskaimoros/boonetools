import { booneToolsApi } from '../api/boonetools.js';

export async function fetchPolTracker(options = {}) {
  return booneToolsApi.get('/pol-tvl', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    errorMessage: ({ response }) => `POL TVL history failed (${response.status})`,
    challengeMessage: 'POL TVL backend returned a challenge response'
  });
}
