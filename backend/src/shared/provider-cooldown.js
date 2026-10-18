import { config } from '../lib/config.js';
import { ProviderCooldownError, providerCooldownKeys, PAYLOAD_SIZE_PATTERN,
  providerErrorMessage as errorMessage, isProviderRateLimitError,
  isProviderGatewayRateLimitError, shouldRecordServiceFailure } from '../../../shared/provider-policy.js';
export { ProviderCooldownError, providerCooldownKeys, isProviderRateLimitError,
  isProviderGatewayRateLimitError, isProviderPayloadSizeError } from '../../../shared/provider-policy.js';

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
    providerCooldownEnabled: enabled(options),
    providerScope: options.scope || '',
    beforeRequest: ({ base }) => assertProviderAvailable(base, options),
    onProviderError: (error, { base }) => recordProviderFailure(base, error, options)
  };
}
