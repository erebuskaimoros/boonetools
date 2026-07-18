import { booneToolsApi } from '../api/boonetools.js';

function getConfigError() {
  // The canonical client defaults to the same-origin public `/functions/v1`
  // route. An explicit base and browser-visible client token are both optional.
  return '';
}

export function getRapidSwapsApiConfigError() {
  return getConfigError();
}

export async function fetchRapidSwapsDashboard(options = {}) {
  const configError = getConfigError();
  if (configError) {
    throw new Error(configError);
  }

  return booneToolsApi.get('/rapid-swaps-summary', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    query: options.params,
    errorMessage: ({ response }) => `Rapid swaps backend request failed (${response.status})`,
    challengeMessage: 'Rapid swaps backend returned challenge response'
  });
}

export async function fetchRapidSwapsSwapHistory(params = {}) {
  const configError = getConfigError();
  if (configError) {
    throw new Error(configError);
  }

  return booneToolsApi.get('/rapid-swaps-swap-history', {
    cache: 'default',
    query: params,
    errorMessage: ({ response }) => `Rapid swaps history request failed (${response.status})`,
    challengeMessage: 'Rapid swaps history backend returned challenge response'
  });
}
