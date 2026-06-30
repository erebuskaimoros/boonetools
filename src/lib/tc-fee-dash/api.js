const TC_FEE_DASH_API = {
  base: (
    import.meta.env.VITE_TC_FEE_DASH_API_BASE ||
    import.meta.env.VITE_NODEOP_API_BASE ||
    '/functions/v1'
  ).replace(/\/$/, ''),
  key: import.meta.env.VITE_TC_FEE_DASH_API_KEY || import.meta.env.VITE_NODEOP_API_KEY || ''
};

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
}

export async function fetchTcFeeDash(options = {}) {
  const params = new URLSearchParams();
  if (options.forceRefresh) {
    params.set('ts', String(Date.now()));
  }

  const headers = { Accept: 'application/json' };
  if (TC_FEE_DASH_API.key) {
    headers.apikey = TC_FEE_DASH_API.key;
    headers.Authorization = `Bearer ${TC_FEE_DASH_API.key}`;
  }

  const url = `${TC_FEE_DASH_API.base}/tc-fee-dash${params.toString() ? `?${params}` : ''}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    let message = `TC fee dashboard request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }

  if (isChallengeResponse(response)) {
    throw new Error('TC fee dashboard backend returned a challenge response');
  }

  return response.json();
}
