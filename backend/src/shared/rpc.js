import { config } from '../lib/config.js';

const RPC_TIMEOUT_MS = 15000;

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
}

function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

function parseJson(text, url) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

async function fetchJsonUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 160)}`);
    }

    if (isChallengeResponse(response)) {
      throw new Error(`Challenge response for ${url}`);
    }

    return parseJson(text, url);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchFromBases(bases, path, params = {}, options = {}) {
  let lastError = null;

  for (const base of bases.filter(Boolean).map(trimBaseUrl)) {
    const url = new URL(`${base}${normalizePath(path)}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    try {
      return await fetchJsonUrl(url.toString(), options.timeoutMs || RPC_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to fetch ${path}`);
}

export async function fetchThorchainRpc(path, params = {}, options = {}) {
  return fetchFromBases(options.rpcUrls || config.rpcRestUrls, path, params, {
    timeoutMs: options.timeoutMs || RPC_TIMEOUT_MS
  });
}
