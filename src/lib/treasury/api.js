import { booneToolsApi } from '$lib/api/boonetools';

export async function fetchTreasurySnapshot(options = {}) {
  return booneToolsApi.get('/treasury-snapshot', {
    signal: options.signal,
    cache: options.forceRefresh ? 'no-cache' : undefined,
    errorMessage: 'Failed to load the cached Treasury snapshot'
  });
}
