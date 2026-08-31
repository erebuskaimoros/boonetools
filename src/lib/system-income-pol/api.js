import { booneToolsApi } from '../api/boonetools.js';

export async function fetchSystemIncomePol(options = {}) {
  return booneToolsApi.get('/pol-tracker', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    errorMessage: ({ response }) => `System Income POL failed (${response.status})`,
    challengeMessage: 'System Income POL backend returned a challenge response'
  });
}
