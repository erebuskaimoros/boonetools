import { config } from './config.js';

export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'accept, authorization, x-client-info, apikey, content-type, prefer, x-nodeop-secret',
  'Access-Control-Expose-Headers': 'etag, preference-applied, retry-after, server-timing, x-boone-age, x-boone-cache, x-boone-schema-version, x-ratelimit-limit, x-ratelimit-remaining',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
});

export function json(body, status = 200, headers = {}) {
  return {
    status,
    body,
    headers
  };
}

export function error(message, status = 500, headers = {}) {
  return json({ error: message }, status, headers);
}

export function parseUrl(request) {
  return new URL(request.url, 'http://127.0.0.1');
}

export function normalizeRoutePath(pathname) {
  const path = pathname || '/';
  if (path.startsWith('/functions/v1/')) {
    return path.slice('/functions/v1'.length);
  }
  if (path === '/functions/v1') {
    return '/';
  }
  return path;
}

export function isValidThorAddress(address) {
  if (!address) {
    return false;
  }
  const normalized = String(address).trim().toLowerCase();
  return normalized.startsWith('thor') && normalized.length === 43;
}

export function parseIntegerParam(value, fallback, options = {}) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const integer = Math.trunc(parsed);
  const min = Number.isFinite(options.min) ? Number(options.min) : integer;
  const max = Number.isFinite(options.max) ? Number(options.max) : integer;

  return Math.min(max, Math.max(min, integer));
}

export function isAuthorizedPublicRequest(request) {
  // Compatibility helper for older integrations. Browser VITE_* tokens are
  // public identifiers, not secrets; all read-only API routes are now openly
  // served and protected by request rate limiting in server.js.
  if (!config.publicApiKey) {
    return true;
  }

  const apiKey = request.headers.apikey || '';
  const authHeader = request.headers.authorization || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  return apiKey === config.publicApiKey || bearer === config.publicApiKey;
}

export function sendResponse(response, result) {
  const status = Number(result?.status) || 200;
  const bodyless = status === 204 || status === 304;
  const payload = bodyless ? '' : JSON.stringify(result?.body ?? {});
  const bytes = Buffer.byteLength(payload);
  const headers = {
    ...CORS_HEADERS,
    ...(bodyless ? {} : { 'Content-Type': 'application/json' }),
    ...result?.headers,
    ...(bodyless ? {} : { 'Content-Length': String(bytes) })
  };

  response.writeHead(status, headers);
  response.end(payload);
  return { status, bytes };
}
