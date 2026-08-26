import { booneToolsApi } from '../api/boonetools.js';

export function fetchPoolAnalysis(options = {}) {
  return booneToolsApi.get('/pool-analysis', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    signal: options.signal,
    errorMessage: ({ response }) => `Pool Analysis snapshot failed (${response.status})`,
    challengeMessage: 'Pool Analysis backend returned a challenge response'
  });
}

export function fetchPoolAnalysisSeries(asset, range = '30d', options = {}) {
  return booneToolsApi.get('/pool-analysis-series', {
    query: { asset, range },
    cache: options.forceRefresh ? 'no-cache' : undefined,
    signal: options.signal,
    errorMessage: ({ response }) => `Pool history failed (${response.status})`,
    challengeMessage: 'Pool Analysis backend returned a challenge response'
  });
}
