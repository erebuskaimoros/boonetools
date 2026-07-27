/**
 * Isomorphic provider transport shared by browser and backend adapters.
 * Domain clients retain response-validation and stop/fallback policy.
 */

export class ProviderRequestError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'ProviderRequestError';
    this.status = Number(details.status) || 0;
    this.statusText = String(details.statusText || '');
    this.url = String(details.url || '');
    this.body = String(details.body || '');
    this.provider = String(details.provider || '');
    this.retryAfterSeconds = Math.max(0, Math.trunc(Number(details.retryAfterSeconds) || 0));
  }
}

export function isProviderChallengeResponse(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const cfMitigated = response?.headers?.get?.('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
}

function providerUrl(base, path) {
  const normalizedBase = String(base || '').replace(/\/$/, '');
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path || ''}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function readResponseBody(response, responseType, url) {
  if (responseType === 'response') return response;
  if (responseType === 'text') return response.text();

  if (typeof response.text === 'function') {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ProviderRequestError(`Invalid JSON from ${url}`, {
        url,
        body: text.slice(0, 240),
        cause: error
      });
    }
  }

  return response.json();
}

async function readErrorBody(response) {
  if (typeof response?.text !== 'function') return '';
  return response.text().catch(() => '');
}

function validationError(result, path, url) {
  if (!result) return null;
  if (result instanceof Error) return result;
  const message = typeof result === 'string'
    ? result
    : `Provider returned an unusable response for ${path}`;
  return new ProviderRequestError(message, { url });
}

function combinedSignal(callerSignal, timeoutSignal) {
  if (!callerSignal) return { signal: timeoutSignal, cleanup() {} };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([callerSignal, timeoutSignal]), cleanup() {} };
  }

  // Modern targets support AbortSignal.any. The fallback keeps caller aborts
  // working in older runtimes by forwarding either source into one controller.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (callerSignal.aborted || timeoutSignal.aborted) {
    abort();
  } else {
    callerSignal.addEventListener?.('abort', abort, { once: true });
    timeoutSignal.addEventListener?.('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      callerSignal.removeEventListener?.('abort', abort);
      timeoutSignal.removeEventListener?.('abort', abort);
    }
  };
}

export async function requestFromProviders(options = {}) {
  const {
    bases = [],
    path = '/',
    timeoutMs = 10000,
    responseType = 'json',
    headers = {},
    request = {},
    fetchImpl = globalThis.fetch,
    validateResponse = null,
    shouldStop = null,
    beforeRequest = null,
    onProviderError = null,
    onProviderSuccess = null,
    errorMessage = null
  } = options;
  const baseList = [...new Set((Array.isArray(bases) ? bases : [bases]).filter(Boolean))];

  if (baseList.length === 0) {
    throw new ProviderRequestError(`No providers configured for ${path}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new ProviderRequestError(`No fetch implementation available for ${path}`);
  }

  let lastError = null;

  for (const base of baseList) {
    const url = providerUrl(base, path);
    const controller = new AbortController();
    const normalizedTimeoutMs = Math.max(1, Math.trunc(Number(timeoutMs) || 10000));
    const timeoutId = setTimeout(() => controller.abort(), normalizedTimeoutMs);
    const requestSignal = combinedSignal(request.signal, controller.signal);

    try {
      if (typeof beforeRequest === 'function') {
        await beforeRequest({ base, path, url });
      }
      const response = await fetchImpl(url, {
        ...request,
        headers: {
          ...headers,
          ...(request.headers || {})
        },
        signal: requestSignal.signal
      });

      if (!response.ok) {
        const body = await readErrorBody(response);
        const details = {
          status: response.status,
          statusText: response.statusText,
          url,
          body: body.slice(0, 240),
          provider: String(base),
          retryAfterSeconds: Math.max(
            0,
            Math.trunc(Number(response.headers?.get?.('retry-after')) || 0)
          )
        };
        const message = typeof errorMessage === 'function'
          ? errorMessage({ ...details, path })
          : `HTTP ${response.status} ${response.statusText || ''} for ${url}`.trim();
        throw new ProviderRequestError(message, details);
      }

      if (isProviderChallengeResponse(response)) {
        throw new ProviderRequestError(`Challenge response for ${url}`, {
          url,
          provider: String(base)
        });
      }

      const payload = await readResponseBody(response, responseType, url);
      if (typeof validateResponse === 'function') {
        const invalid = validationError(
          validateResponse(payload, { base, path, response, url }),
          path,
          url
        );
        if (invalid) throw invalid;
      }

      if (typeof onProviderSuccess === 'function') {
        await onProviderSuccess({ base, path, url, response, payload });
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (typeof onProviderError === 'function') {
        await onProviderError(error, { base, path, url });
      }
      if (typeof shouldStop === 'function' && shouldStop(error, { base, path, url })) {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
      requestSignal.cleanup();
    }
  }

  throw lastError || new ProviderRequestError(`Unable to fetch ${path}`);
}
