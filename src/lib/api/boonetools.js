/**
 * Shared client for BooneTools' own `/functions/v1` API.
 *
 * `VITE_BOONETOOLS_API_BASE` and `VITE_BOONETOOLS_API_KEY` are the canonical
 * frontend settings. The feature-specific names remain accepted as migration
 * aliases so existing deployments do not need an atomic environment change.
 */

export const DEFAULT_BOONETOOLS_API_BASE = '/functions/v1';

export const BOONETOOLS_API_BASE_ENV_KEYS = Object.freeze([
  'VITE_BOONETOOLS_API_BASE',
  'VITE_NODEOP_API_BASE',
  'VITE_APP_LAYER_API_BASE',
  'VITE_NODE_VOTES_API_BASE',
  'VITE_RAPID_SWAPS_API_BASE',
  'VITE_TC_FEE_DASH_API_BASE'
]);

export const BOONETOOLS_API_KEY_ENV_KEYS = Object.freeze([
  'VITE_BOONETOOLS_API_KEY',
  'VITE_NODEOP_API_KEY',
  'VITE_APP_LAYER_API_KEY',
  'VITE_NODE_VOTES_API_KEY',
  'VITE_RAPID_SWAPS_API_KEY',
  'VITE_TC_FEE_DASH_API_KEY'
]);

const runtimeEnv = import.meta.env || {};
const responseMetadata = new WeakMap();

export const BOONETOOLS_API_META = Symbol.for('boonetools.api.meta');

function firstConfiguredValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return { source: key, value: String(value).trim() };
    }
  }

  return null;
}

function normalizeBase(base) {
  const normalized = String(base || '').trim().replace(/\/+$/, '');
  return normalized || DEFAULT_BOONETOOLS_API_BASE;
}

/**
 * Resolve one API origin/key for every frontend feature.
 *
 * @param {Record<string, unknown>} env Vite-style environment object.
 */
export function resolveBooneToolsApiConfig(env = runtimeEnv) {
  const configuredBase = firstConfiguredValue(env, BOONETOOLS_API_BASE_ENV_KEYS);
  const configuredKey = firstConfiguredValue(env, BOONETOOLS_API_KEY_ENV_KEYS);

  return Object.freeze({
    base: normalizeBase(configuredBase?.value),
    key: configuredKey?.value || '',
    baseSource: configuredBase?.source || 'default',
    keySource: configuredKey?.source || '',
    isBaseConfigured: Boolean(configuredBase),
    isKeyConfigured: Boolean(configuredKey)
  });
}

export function isBooneToolsChallengeResponse(response) {
  const contentType = (response?.headers?.get?.('content-type') || '').toLowerCase();
  return contentType.includes('text/html') || Boolean(response?.headers?.get?.('cf-mitigated'));
}

export function buildBooneToolsApiHeaders(key, extraHeaders = {}) {
  const headers = { Accept: 'application/json' };

  if (key) {
    headers.apikey = key;
    headers.Authorization = `Bearer ${key}`;
  }

  if (typeof Headers !== 'undefined' && extraHeaders instanceof Headers) {
    return { ...headers, ...Object.fromEntries(extraHeaders.entries()) };
  }

  return { ...headers, ...(extraHeaders || {}) };
}

function addQueryValues(params, query) {
  if (!query) return;

  if (query instanceof URLSearchParams) {
    for (const [key, value] of query.entries()) params.set(key, value);
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
}

export function buildBooneToolsApiUrl(base, path, options = {}) {
  const normalizedBase = normalizeBase(base);
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  const params = new URLSearchParams();

  if (options.forceRefresh) {
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    params.set('ts', String(now));
  }
  addQueryValues(params, options.query);

  const queryString = params.toString();
  return `${normalizedBase}${normalizedPath}${queryString ? `?${queryString}` : ''}`;
}

async function readResponseText(response) {
  if (typeof response?.text === 'function') {
    return response.text();
  }

  if (typeof response?.json === 'function') {
    return JSON.stringify(await response.json());
  }

  return '';
}

function parseJsonText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function payloadErrorMessage(payload) {
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
  if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) {
    return payload.error.message;
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  if (payload?.data && payload.data !== payload) return payloadErrorMessage(payload.data);
  return '';
}

function isVersionedEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!Object.prototype.hasOwnProperty.call(payload, 'data')) return false;
  if (!Object.prototype.hasOwnProperty.call(payload, 'meta')) return false;

  const keys = Object.keys(payload);
  return keys.every((key) => key === 'data' || key === 'meta')
    || Number(payload.meta?.schemaVersion || payload.meta?.schema_version) >= 2;
}

/**
 * Convert the versioned `{ data, meta }` API contract back to the established
 * feature payload while retaining contract metadata out-of-band. This keeps
 * existing dashboard access patterns unchanged, including feature-owned
 * `payload.meta` fields.
 */
export function normalizeBooneToolsApiPayload(payload) {
  if (!isVersionedEnvelope(payload)) return payload;

  let data = payload.data;
  if (
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && !Object.prototype.hasOwnProperty.call(data, 'meta')
  ) {
    if (Object.isExtensible(data)) {
      Object.defineProperty(data, 'meta', {
        configurable: true,
        enumerable: true,
        value: payload.meta ?? null,
        writable: true
      });
    } else {
      data = { ...data, meta: payload.meta ?? null };
    }
  }

  if (data && (typeof data === 'object' || typeof data === 'function')) {
    responseMetadata.set(data, payload.meta ?? null);

    if (Object.isExtensible(data)) {
      Object.defineProperty(data, BOONETOOLS_API_META, {
        configurable: true,
        enumerable: false,
        value: payload.meta ?? null
      });
    }
  }

  return data;
}

/**
 * Read transport-level metadata from either a normalized v2 payload, a raw
 * `{ data, meta }` envelope, or a legacy payload with its own `meta` field.
 */
export function getBooneToolsApiMeta(payload) {
  if (!payload || (typeof payload !== 'object' && typeof payload !== 'function')) return null;
  if (isVersionedEnvelope(payload)) return payload.meta ?? null;
  return responseMetadata.get(payload) || payload[BOONETOOLS_API_META] || payload.meta || null;
}

export class BooneToolsApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BooneToolsApiError';
    this.status = Number(details.status) || 0;
    this.statusText = details.statusText || '';
    this.url = details.url || '';
    this.payload = details.payload ?? null;
    this.body = details.body || '';
  }
}

function resolveErrorMessage(errorMessage, context) {
  if (typeof errorMessage === 'function') return errorMessage(context);
  if (typeof errorMessage === 'string' && errorMessage) return errorMessage;
  return `BooneTools API request failed (${context.response.status})`;
}

/**
 * Create a client. Supplying `fetchImpl` and `now` keeps transport behavior
 * deterministic in tests without introducing runtime-only globals.
 */
export function createBooneToolsApiClient(options = {}) {
  const resolved = resolveBooneToolsApiConfig(options.env || runtimeEnv);
  const config = Object.freeze({
    ...resolved,
    ...(options.base === undefined ? {} : {
      base: normalizeBase(options.base),
      baseSource: 'client',
      isBaseConfigured: Boolean(String(options.base || '').trim())
    }),
    ...(options.key === undefined ? {} : {
      key: String(options.key || ''),
      keySource: options.key ? 'client' : '',
      isKeyConfigured: Boolean(options.key)
    })
  });

  async function request(path, requestOptions = {}) {
    const url = buildBooneToolsApiUrl(config.base, path, {
      query: requestOptions.query,
      forceRefresh: requestOptions.forceRefresh,
      now: options.now
    });
    const fetchImpl = options.fetchImpl || globalThis.fetch;

    if (typeof fetchImpl !== 'function') {
      throw new Error('Fetch is not available for BooneTools API requests');
    }

    const fetchOptions = {
      method: requestOptions.method || 'GET',
      headers: buildBooneToolsApiHeaders(config.key, requestOptions.headers)
    };

    if (requestOptions.cache !== undefined) fetchOptions.cache = requestOptions.cache;
    if (requestOptions.signal !== undefined) fetchOptions.signal = requestOptions.signal;
    if (requestOptions.body !== undefined) fetchOptions.body = requestOptions.body;

    const response = await fetchImpl(url, fetchOptions);

    if (!response.ok) {
      const body = await readResponseText(response);
      const payload = parseJsonText(body);
      const context = { response, payload, body, url };
      const decodedMessage = requestOptions.preferPayloadError === false
        ? ''
        : payloadErrorMessage(payload);
      const message = decodedMessage || resolveErrorMessage(requestOptions.errorMessage, context);

      throw new BooneToolsApiError(message, {
        status: response.status,
        statusText: response.statusText,
        url,
        payload,
        body
      });
    }

    if (isBooneToolsChallengeResponse(response)) {
      throw new BooneToolsApiError(
        requestOptions.challengeMessage || 'BooneTools backend returned a challenge response',
        {
          status: response.status,
          statusText: response.statusText,
          url
        }
      );
    }

    if (typeof response.json === 'function') {
      const payload = await response.json();
      return requestOptions.normalizeEnvelope === false
        ? payload
        : normalizeBooneToolsApiPayload(payload);
    }

    const body = await readResponseText(response);
    const payload = JSON.parse(body);
    return requestOptions.normalizeEnvelope === false
      ? payload
      : normalizeBooneToolsApiPayload(payload);
  }

  return Object.freeze({
    config,
    request,
    get(path, optionsForGet = {}) {
      return request(path, { ...optionsForGet, method: 'GET' });
    }
  });
}

export const booneToolsApiConfig = resolveBooneToolsApiConfig();
export const booneToolsApi = createBooneToolsApiClient({
  base: booneToolsApiConfig.base,
  key: booneToolsApiConfig.key
});
