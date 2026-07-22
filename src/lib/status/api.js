import { booneToolsApi } from '../api/boonetools.js';

export async function fetchNetworkSnapshot(options = {}) {
  return booneToolsApi.get('/network-snapshot', {
    forceRefresh: options.forceRefresh,
    query: options.forceRefresh ? { refresh: 1 } : undefined,
    errorMessage: ({ response }) => `Network snapshot failed (${response.status})`,
    challengeMessage: 'Network snapshot backend returned a challenge response'
  });
}

export async function fetchStatusDashboard(options = {}) {
  return booneToolsApi.get('/status-dashboard', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    errorMessage: ({ response }) => `Status dashboard failed (${response.status})`,
    challengeMessage: 'Status dashboard backend returned a challenge response'
  });
}

export async function fetchStatusLive(options = {}) {
  return booneToolsApi.get('/status-live', {
    cache: options.revalidate ? 'no-cache' : undefined,
    errorMessage: ({ response }) => `Live status failed (${response.status})`,
    challengeMessage: 'Live status backend returned a challenge response'
  });
}

export async function fetchStuckTransactions(options = {}) {
  return booneToolsApi.get('/stuck-transactions', {
    forceRefresh: options.forceRefresh,
    errorMessage: ({ response }) => `Stuck transaction scan failed (${response.status})`,
    challengeMessage: 'Stuck transaction backend returned a challenge response'
  });
}
