import { booneToolsApi } from '../api/boonetools.js';

export async function fetchNodeVotesDashboard(options = {}) {
  return booneToolsApi.get('/node-votes', {
    forceRefresh: options.forceRefresh,
    query: { days: options.days || undefined },
    errorMessage: ({ response }) => `Node vote backend request failed (${response.status})`,
    challengeMessage: 'Node vote backend returned a challenge response'
  });
}
