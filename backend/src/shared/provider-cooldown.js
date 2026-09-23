import { config } from '../lib/config.js';

// Error messages include request URLs, where heights and hashes can contain
// 429. Recognize the number only when it is written as an HTTP status.
const RATE_LIMIT_PATTERN = /\bHTTP(?:\/\d(?:\.\d)?)?\s+429\b|\bRequest failed\s*\(429\)|too many requests|daily request limit|rate.?limit|rune pouch is empty|too many breaches|temporarily blocked/i;
const PAYLOAD_SIZE_PATTERN = /\bgrpc:\s*(?:received|sent) message larger than max\b|\b(?:request|response|payload|entity) (?:body )?too large\b/i;

export class ProviderCooldownError extends Error {
  constructor(providerKey, blockedUntil, reason = '') {
    super(`Provider ${providerKey} is cooling down until ${blockedUntil}${reason ? `: ${reason}` : ''}`);
    this.name = 'ProviderCooldownError';
    this.providerKey = providerKey;
    this.blockedUntil = blockedUntil;
    this.skipProvider = true;
  }
}

function providerHostname(base) {
  try {
    return new URL(String(base || '')).hostname.toLowerCase();
  } catch {
    return String(base || '').trim().toLowerCase();
  }
}

function providerServicePath(base) {
  try {
    const pathname = new URL(String(base || '')).pathname
      .replace(/\/+$/, '')
      .toLowerCase();
    if (/^\/api=[^/]+/i.test(pathname)) {
      return '/api=dedicated';
    }
    const liquifyService = pathname.match(/^\/chain\/[^/]+/i)?.[0];
    return liquifyService || pathname;
  } catch {
    return '';
  }
}

export function providerCooldownKeys(base, options = {}) {
  const hostname = providerHostname(base);
  if (!hostname) return { global: '', service: '' };
  const servicePath = providerServicePath(base);
  const gatewayScope = servicePath === '/api=dedicated'
    ? servicePath
    : '';
  const scope = String(options.scope || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return {
    global: `global:${hostname}${gatewayScope}`,
    service: `service:${hostname}${servicePath}${scope ? `:${scope}` : ''}`
  };
}

function errorMessage(error) {
  const body = typeof error?.body === 'object' ? JSON.stringify(error.body) : error?.body;
  return [error?.message, body].filter(Boolean).map(String).join(' ').slice(0, 500);
}

export function isProviderPayloadSizeError(error) {
  return Number(error?.status) === 413 || PAYLOAD_SIZE_PATTERN.test(errorMessage(error));
}

function isRequestSizeFailure(error) {
  // Liquify maps oversized gRPC replies to HTTP 429. Retrying a smaller query
  // can succeed immediately; it must not disable the whole provider. An
  // explicit Retry-After still takes precedence over this exception.
  return isProviderPayloadSizeError(error) && !(Number(error?.retryAfterSeconds) > 0);
}

export function isProviderRateLimitError(error) {
  if (isRequestSizeFailure(error)) return false;
  return Number(error?.status) === 429 || RATE_LIMIT_PATTERN.test(errorMessage(error));
}

export function isProviderGatewayRateLimitError(error) {
  if (isRequestSizeFailure(error)) return false;
  return Number(error?.status) === 429 || Number(error?.retryAfterSeconds) > 0;
}

function shouldRecordServiceFailure(error) {
  if (isRequestSizeFailure(error)) return false;
  const status = Number(error?.status) || 0;
  if (isProviderRateLimitError(error) || Number(error?.retryAfterSeconds) > 0) return true;
  if (status === 0) return true;
  return status === 408 || status === 425 || status >= 500;
}

function enabled(options) {
  return options.enabled === undefined
    ? config.providerCooldownEnabled
    : Boolean(options.enabled);
}

function database(options = {}) {
  if (options.client?.query) return options.client;
  return {
    async query(...args) {
      const { query } = await import('../db/pool.js');
      return query(...args);
    }
  };
}

export async function assertProviderAvailable(base, options = {}) {
  if (!enabled(options)) return;
  const keys = providerCooldownKeys(base, options);
  const candidates = [keys.global, keys.service].filter(Boolean);
  if (!candidates.length) return;
  try {
    const { rows } = await database(options).query(
      `select provider_key, blocked_until, last_error, failure_count
       from provider_circuit_breakers
       where provider_key = any($1::text[])`,
      [candidates]
    );
    const row = rows.find((candidate) => {
      const reason = String(candidate.last_error || '');
      // Releases before request-size classification persisted these as global
      // 429 failures. Ignore only that recognizable legacy reason; an explicit
      // Retry-After marker or a different blocked lane must still be honored.
      const obsoleteSizeFailure = PAYLOAD_SIZE_PATTERN.test(reason)
        && !/\bRetry-After\b/i.test(reason);
      return !obsoleteSizeFailure
        && Date.parse(String(candidate.blocked_until || '')) > Date.now();
    });
    if (row && Date.parse(String(row.blocked_until || '')) > Date.now()) {
      throw new ProviderCooldownError(
        row.provider_key,
        new Date(row.blocked_until).toISOString(),
        String(row.last_error || '')
      );
    }
    const serviceRow = rows.find((candidate) => candidate.provider_key === keys.service);
    if (serviceRow && Number(serviceRow.failure_count || 0) > 0) {
      await recordProviderSuccess(base, options);
    }
  } catch (error) {
    if (error instanceof ProviderCooldownError) throw error;
    // Provider traffic should not fail solely because cooldown bookkeeping is
    // unavailable. The provider request remains the authoritative operation.
  }
}

export async function recordProviderFailure(base, error, options = {}) {
  if (!enabled(options) || error?.skipProvider) return;
  if (!shouldRecordServiceFailure(error)) return;
  const keys = providerCooldownKeys(base, options);
  const globalRateLimited = isProviderGatewayRateLimitError(error);
  const key = globalRateLimited ? keys.global : keys.service;
  if (!key) return;
  const rateLimited = isProviderRateLimitError(error);
  const retryAfterMs = Math.max(0, Number(error?.retryAfterSeconds) || 0) * 1000;
  const cooldownMs = Math.max(
    rateLimited ? config.providerRateLimitCooldownMs : config.providerFailureCooldownMs,
    retryAfterMs
  );
  const blockedUntil = new Date(Date.now() + cooldownMs).toISOString();
  const reason = `${errorMessage(error)}${retryAfterMs > 0 ? ` [Retry-After: ${retryAfterMs / 1000}s]` : ''}`;
  try {
    await database(options).query(
      `insert into provider_circuit_breakers (
         provider_key, failure_count, last_status, last_error,
         last_failed_at, blocked_until, updated_at
       ) values ($1, 1, $2, $3, now(), $4, now())
       on conflict (provider_key)
       do update set
         failure_count = provider_circuit_breakers.failure_count + 1,
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         last_failed_at = now(),
         blocked_until = greatest(provider_circuit_breakers.blocked_until, excluded.blocked_until),
         updated_at = now()`,
      [key, Number(error?.status) || 0, reason, blockedUntil]
    );
  } catch {
    // Best-effort shared protection; never replace the original provider error.
  }
}

export async function recordProviderSuccess(base, options = {}) {
  if (!enabled(options)) return;
  const key = providerCooldownKeys(base, options).service;
  if (!key) return;
  try {
    await database(options).query(
      `update provider_circuit_breakers
       set failure_count = 0,
           last_status = 0,
           last_error = '',
           last_success_at = now(),
           blocked_until = null,
           updated_at = now()
       where provider_key = $1`,
      [key]
    );
  } catch {
    // See recordProviderFailure: bookkeeping is deliberately non-fatal.
  }
}

export function providerLifecycleHooks(options = {}) {
  return {
    beforeRequest: ({ base }) => assertProviderAvailable(base, options),
    onProviderError: (error, { base }) => recordProviderFailure(base, error, options)
  };
}
