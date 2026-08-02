import { config } from '../lib/config.js';

const RATE_LIMIT_PATTERN = /429|too many requests|daily request limit|rate.?limit|rune pouch is empty|too many breaches|temporarily blocked/i;

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
    const liquifyService = pathname.match(/^\/chain\/[^/]+/i)?.[0];
    return liquifyService || pathname;
  } catch {
    return '';
  }
}

export function providerCooldownKeys(base) {
  const hostname = providerHostname(base);
  if (!hostname) return { global: '', service: '' };
  return {
    global: `global:${hostname}`,
    service: `service:${hostname}${providerServicePath(base)}`
  };
}

function errorMessage(error) {
  return [error?.message, error?.body].map(String).filter(Boolean).join(' ').slice(0, 500);
}

export function isProviderRateLimitError(error) {
  return Number(error?.status) === 429 || RATE_LIMIT_PATTERN.test(errorMessage(error));
}

export function isProviderGatewayRateLimitError(error) {
  return Number(error?.status) === 429 || Number(error?.retryAfterSeconds) > 0;
}

function shouldRecordServiceFailure(error) {
  const status = Number(error?.status) || 0;
  if (isProviderRateLimitError(error)) return true;
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
  const keys = providerCooldownKeys(base);
  const candidates = [keys.global, keys.service].filter(Boolean);
  if (!candidates.length) return;
  try {
    const { rows } = await database(options).query(
      `select provider_key, blocked_until, last_error, failure_count
       from provider_circuit_breakers
       where provider_key = any($1::text[])`,
      [candidates]
    );
    const row = rows.find((candidate) => (
      Date.parse(String(candidate.blocked_until || '')) > Date.now()
    ));
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
  const keys = providerCooldownKeys(base);
  const globalRateLimited = isProviderGatewayRateLimitError(error);
  const key = globalRateLimited ? keys.global : keys.service;
  if (!key) return;
  const rateLimited = isProviderRateLimitError(error);
  const retryAfterMs = Math.max(0, Number(error?.retryAfterSeconds) || 0) * 1000;
  const cooldownMs = rateLimited
    ? Math.max(config.providerRateLimitCooldownMs, retryAfterMs)
    : config.providerFailureCooldownMs;
  const blockedUntil = new Date(Date.now() + cooldownMs).toISOString();
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
      [key, Number(error?.status) || 0, errorMessage(error), blockedUntil]
    );
  } catch {
    // Best-effort shared protection; never replace the original provider error.
  }
}

export async function recordProviderSuccess(base, options = {}) {
  if (!enabled(options)) return;
  const key = providerCooldownKeys(base).service;
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
