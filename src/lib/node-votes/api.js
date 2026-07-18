import { booneToolsApi } from '../api/boonetools.js';

export async function fetchNodeVotesDashboard(options = {}) {
  return booneToolsApi.get('/node-votes-summary', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    query: { days: options.days || undefined },
    errorMessage: ({ response }) => `Node vote backend request failed (${response.status})`,
    challengeMessage: 'Node vote backend returned a challenge response'
  });
}

export async function fetchNodeVoteDetails(key, options = {}) {
  return booneToolsApi.get('/node-votes/vote', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    query: { key, cursor: options.cursor, limit: options.limit },
    errorMessage: ({ response }) => `Node vote detail request failed (${response.status})`,
    challengeMessage: 'Node vote backend returned a challenge response'
  });
}

export async function fetchNodeVoteNodeDetails(address, options = {}) {
  return booneToolsApi.get('/node-votes/node', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    query: { address, cursor: options.cursor, limit: options.limit },
    errorMessage: ({ response }) => `Node vote detail request failed (${response.status})`,
    challengeMessage: 'Node vote backend returned a challenge response'
  });
}
