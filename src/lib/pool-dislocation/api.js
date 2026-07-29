import { booneToolsApi } from '../api/boonetools.js';

export async function fetchPoolDislocation(options = {}) {
  return booneToolsApi.get('/pool-dislocation', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    errorMessage: ({ response }) => `Pool dislocation summary failed (${response.status})`,
    challengeMessage: 'Pool dislocation backend returned a challenge response'
  });
}

export async function fetchPoolDislocationSeries(asset, options = {}) {
  return booneToolsApi.get('/pool-dislocation-series', {
    query: { asset },
    cache: options.forceRefresh ? 'no-cache' : undefined,
    signal: options.signal,
    errorMessage: ({ response }) => `Pool dislocation series failed (${response.status})`,
    challengeMessage: 'Pool dislocation backend returned a challenge response'
  });
}
