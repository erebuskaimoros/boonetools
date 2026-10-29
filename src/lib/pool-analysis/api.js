import { booneToolsApi } from '../api/boonetools.js';
import { localTimeZone } from '../utils/datetime.js';

/** @param {string} asset @param {string} day @param {{ signal?: AbortSignal, timeZone?: string }} [options] */
export function fetchPoolAnalysisSwaps(asset, day, { signal, timeZone = localTimeZone() } = {}) {
  return booneToolsApi.get('/pool-analysis-swaps', {
    query: { asset, day, timeZone }, signal,
    errorMessage: ({ response }) => `Pool swap ranking failed (${response.status})`
  });
}

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
