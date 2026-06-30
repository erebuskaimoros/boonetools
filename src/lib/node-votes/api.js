const NODE_VOTES_API = {
  base: (
    import.meta.env.VITE_NODE_VOTES_API_BASE ||
    import.meta.env.VITE_NODEOP_API_BASE ||
    '/functions/v1'
  ).replace(/\/$/, ''),
  key: import.meta.env.VITE_NODE_VOTES_API_KEY || import.meta.env.VITE_NODEOP_API_KEY || ''
};

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
}

export async function fetchNodeVotesDashboard(options = {}) {
  if (!NODE_VOTES_API.base) {
    throw new Error('Node vote backend is not configured. Set VITE_NODE_VOTES_API_BASE or VITE_NODEOP_API_BASE.');
  }

  const params = new URLSearchParams();
  if (options.forceRefresh) {
    params.set('ts', String(Date.now()));
  }
  if (options.days) {
    params.set('days', String(options.days));
  }

  const headers = { Accept: 'application/json' };
  if (NODE_VOTES_API.key) {
    headers.apikey = NODE_VOTES_API.key;
    headers.Authorization = `Bearer ${NODE_VOTES_API.key}`;
  }

  const url = `${NODE_VOTES_API.base}/node-votes${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    let message = `Node vote backend request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // Keep the default status message.
    }
    throw new Error(message);
  }

  if (isChallengeResponse(response)) {
    throw new Error('Node vote backend returned a challenge response');
  }

  return response.json();
}
