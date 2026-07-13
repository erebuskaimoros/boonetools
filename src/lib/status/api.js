const STATUS_API = {
  base: (
    import.meta.env.VITE_NODEOP_API_BASE ||
    import.meta.env.VITE_NODE_VOTES_API_BASE ||
    '/functions/v1'
  ).replace(/\/$/, ''),
  key: import.meta.env.VITE_NODEOP_API_KEY || import.meta.env.VITE_NODE_VOTES_API_KEY || ''
};

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  return contentType.includes('text/html') || Boolean(response.headers.get('cf-mitigated'));
}

export async function fetchStuckTransactions(options = {}) {
  const params = new URLSearchParams();
  if (options.forceRefresh) params.set('ts', String(Date.now()));

  const headers = { Accept: 'application/json' };
  if (STATUS_API.key) {
    headers.apikey = STATUS_API.key;
    headers.Authorization = `Bearer ${STATUS_API.key}`;
  }

  const query = params.toString();
  const response = await fetch(`${STATUS_API.base}/stuck-transactions${query ? `?${query}` : ''}`, {
    headers
  });
  if (!response.ok) {
    let message = `Stuck transaction scan failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }
  if (isChallengeResponse(response)) {
    throw new Error('Stuck transaction backend returned a challenge response');
  }
  return response.json();
}
