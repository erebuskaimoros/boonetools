import { booneToolsApi } from '../api/boonetools.js';

export async function fetchTcFeeDash(options = {}) {
  return booneToolsApi.get('/tc-fee-dash', {
    forceRefresh: options.forceRefresh,
    errorMessage: ({ response }) => `TC fee dashboard request failed (${response.status})`,
    challengeMessage: 'TC fee dashboard backend returned a challenge response'
  });
}
