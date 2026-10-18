// Runtime-neutral failure classification shared by durable backend breakers
// and the browser/process-local provider queues. Never infer a 429 from a
// height/hash, or confuse Liquify's oversized-response 429 with a quota.
export const RATE_LIMIT_PATTERN = /\bHTTP(?:\/\d(?:\.\d)?)?\s+429\b|\bRequest failed\s*\(429\)|too many requests|daily request limit|rate.?limit|rune pouch is empty|too many breaches|temporarily blocked/i;
export const PAYLOAD_SIZE_PATTERN = /\bgrpc:\s*(?:received|sent) message larger than max\b|\b(?:request|response|payload|entity) (?:body )?too large\b/i;

export class ProviderCooldownError extends Error {
  constructor(providerKey, blockedUntil, reason = '') {
    super(`Provider ${providerKey} is cooling down until ${blockedUntil}${reason ? `: ${reason}` : ''}`);
    this.name = 'ProviderCooldownError';
    this.providerKey = providerKey;
    this.blockedUntil = blockedUntil;
    this.skipProvider = true;
  }
}

export function providerCooldownKeys(base, options = {}) {
  let hostname, servicePath = '';
  try {
    const url = new URL(String(base || ''));
    hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
    servicePath = /^\/api=[^/]+/i.test(pathname) ? '/api=dedicated'
      : pathname.match(/^\/chain\/[^/]+/i)?.[0] || pathname;
  } catch { hostname = String(base || '').trim().toLowerCase(); }
  if (!hostname) return { global: '', service: '' };
  const scope = String(options.scope || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return {
    global: `global:${hostname}${servicePath === '/api=dedicated' ? servicePath : ''}`,
    service: `service:${hostname}${servicePath}${scope ? `:${scope}` : ''}`
  };
}

export function providerErrorMessage(error) {
  const body = typeof error?.body === 'object' ? JSON.stringify(error.body) : error?.body;
  return [error?.message, body].filter(Boolean).map(String).join(' ').slice(0, 500);
}

export function isProviderPayloadSizeError(error) {
  return Number(error?.status) === 413 || PAYLOAD_SIZE_PATTERN.test(providerErrorMessage(error));
}

function isRequestSizeFailure(error) {
  return isProviderPayloadSizeError(error) && !(Number(error?.retryAfterSeconds) > 0);
}

export function isProviderRateLimitError(error) {
  return !isRequestSizeFailure(error)
    && (Number(error?.status) === 429 || RATE_LIMIT_PATTERN.test(providerErrorMessage(error)));
}

export function isProviderGatewayRateLimitError(error) {
  return !isRequestSizeFailure(error)
    && (Number(error?.status) === 429 || Number(error?.retryAfterSeconds) > 0);
}

export function shouldRecordServiceFailure(error) {
  if (error?.skipProvider || isRequestSizeFailure(error)) return false;
  const status = Number(error?.status) || 0;
  return isProviderRateLimitError(error) || Number(error?.retryAfterSeconds) > 0
    || status === 0 || status === 408 || status === 425 || status >= 500;
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - now) / 1000)) : 0;
}
