import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';

const WINDOWS = ['minute', 'hour', 'day'];
const MAX_PACING_WAIT_MS = 5_000;
const MAX_PACING_RETRIES = 50;

// node-postgres returns timestamptz as Date; Date.parse(Date) first stringifies
// it and drops milliseconds, which would defeat subsecond pacing.
const timestampMs = (value) => value instanceof Date ? value.getTime() : Date.parse(value);

function normalizedBase(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v\d+$/i, '');
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

// Only the saved-candidate verifier may use the live allowance for actions.
// A purpose flag alone must never admit history scans, filters or pagination.
function isBoundedTransactionVerification(path, purpose) {
  if (purpose !== 'verification') return false;
  const route = new URL(path, 'https://midgard.invalid');
  const params = route.searchParams;
  return /^\/(?:v\d+\/)?actions\/?$/.test(route.pathname) && !route.hash
    && [...params.keys()].length === 2
    && params.getAll('txid').length === 1 && params.getAll('limit').length === 1
    && /^[a-f\d]{64}$/i.test(params.get('txid'))
    && /^(?:[1-9]|[1-4]\d|50)$/.test(params.get('limit'));
}

/** Identify the actual configured provider, never a request's query/address.
 * Versions share a budget; public and dedicated credentials do not. The hash
 * keeps dedicated URLs/credentials out of operational rows and error text. */
export function midgardBudgetContext(url, options = {}) {
  const configured = options.configuredBases || [
    ...config.midgardUrls, ...config.rujiraBaseFeesMidgardUrls, ...config.rujiraReservePaymentsMidgardUrls
  ];
  const bases = (Array.isArray(options.bases) ? options.bases : [options.bases])
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const suppliedBase = bases.find((candidate) => String(url).startsWith(`${String(candidate).replace(/\/+$/, '')}/`));
  if (!suppliedBase) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  // Some clients split a full URL into {base: origin, path: service + route}.
  // Resolve the service from the ACTUAL outbound URL, not merely its base, so
  // those requests share the exact same counter with the normal Midgard helper.
  const servicePrefix = parsed.pathname.match(/^\/chain\/thorchain_midgard(?:\/v\d+)?(?=\/|$)/i)?.[0];
  const configuredBase = configured.flatMap((candidate) => [String(candidate).replace(/\/+$/, ''), normalizedBase(candidate)])
    .filter(Boolean).sort((a, b) => b.length - a.length)
    .find((candidate) => String(url).startsWith(`${candidate}/`));
  const base = servicePrefix ? `${parsed.origin}${servicePrefix}` : configuredBase || suppliedBase;
  const identity = normalizedBase(base);
  const known = Boolean(servicePrefix || configuredBase)
    || /(?:^|\.)midgard(?:\.|$)/i.test(parsed.hostname)
    || configured.some((candidate) => normalizedBase(candidate) === identity);
  if (!known) return null;
  const path = String(url).slice(String(base).replace(/\/+$/, '').length);
  const portal = Boolean(configuredBase) && parsed.protocol === 'https:'
    && parsed.hostname.toLowerCase() === 'gateway.liquify.com'
    && /^\/api=[^/]+(?:\/v\d+)?\/?$/i.test(new URL(configuredBase).pathname);
  return {
    base, path,
    providerKey: `midgard:${parsed.hostname.toLowerCase()}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
    budgetProfile: portal ? 'liquify-portal' : 'default',
    budgetClass: options.midgardBudgetClass === 'bulk'
      || (/^\/(?:v\d+\/)?actions\/?(?:[?#]|$)/.test(path)
        && !isBoundedTransactionVerification(path, options.midgardBudgetClass)) ? 'bulk' : 'live'
  };
}

export class MidgardBudgetDeferredError extends Error {
  constructor({ providerKey, retryAt, reason, now = Date.now(), cause }) {
    super(`Midgard request deferred by shared budget until ${retryAt} (${reason})`, cause ? { cause } : undefined);
    this.name = 'MidgardBudgetDeferredError';
    this.code = 'MIDGARD_BUDGET_DEFERRED';
    this.skipProvider = true;
    this.providerKey = providerKey;
    this.retryAt = retryAt;
    this.blockedUntil = retryAt;
    this.budgetReason = reason;
    this.retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(retryAt) - now) / 1000));
  }
}

export function isMidgardBudgetDeferred(error) {
  return error?.code === 'MIDGARD_BUDGET_DEFERRED';
}

function normalizedLimits(limits) {
  return WINDOWS.map((window) => {
    const value = Number(limits?.[window]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Midgard ${window} budget`);
    return value;
  });
}

/** Explicit client injection is mandatory here: tests never silently fall back
 * to the production database. Only the production singleton below loads it. */
export function createMidgardRequestBudget({ client, total, bulk, portal, now,
  wait = (ms, { signal }) => delay(ms, undefined, { signal }) } = {}) {
  if (typeof client?.query !== 'function') throw new Error('Midgard budget requires an explicit database client');
  const totals = normalizedLimits(total), bulks = normalizedLimits(bulk);
  if (bulks.some((value, index) => value > totals[index])) throw new Error('Midgard bulk budget cannot exceed total budget');
  const portalTotals = portal ? normalizedLimits(portal.total) : null;
  const portalBulks = portal ? normalizedLimits(portal.bulk) : null;
  if (portalBulks?.some((value, index) => value > portalTotals[index])) throw new Error('Midgard Portal bulk budget cannot exceed total budget');
  if (portal && (!Number.isSafeInteger(portal.minIntervalMs) || portal.minIntervalMs < 1 || portal.minIntervalMs > 60_000)) {
    throw new Error('Invalid Midgard Portal pacing interval');
  }
  return {
    async claim({ providerKey, budgetClass = 'live', budgetProfile = 'default', signal }) {
      signal?.throwIfAborted();
      const failureNow = () => now ? Number(now()) : Date.now();
      const paced = Boolean(portal && budgetProfile === 'liquify-portal');
      const startedAt = performance.now();
      let waitedMs = 0, pacingRetries = 0;
      let row;
      while (true) {
        signal?.throwIfAborted();
        try {
          const values = [providerKey, budgetClass === 'bulk', paced ? portalTotals : totals,
            paced ? portalBulks : bulks, now ? new Date(now()).toISOString() : null];
          if (paced) values.push(portal.minIntervalMs);
          ({ rows: [row] } = await client.query(paced
            ? 'select * from claim_midgard_request_budget_paced($1, $2, $3::integer[], $4::integer[], $5::timestamptz, $6::integer)'
            : 'select * from claim_midgard_request_budget($1, $2, $3::integer[], $4::integer[], $5::timestamptz)', values));
          if (!row || typeof row.allowed !== 'boolean'
            || !Number.isFinite(timestampMs(row.allowed ? row.reserved_at : row.retry_at))) {
            throw new Error('Midgard budget returned an invalid reservation');
          }
        } catch (cause) {
          signal?.throwIfAborted();
          const timestamp = failureNow();
          throw new MidgardBudgetDeferredError({ providerKey, reason: 'storage-unavailable',
            retryAt: new Date(timestamp + 60_000).toISOString(), now: timestamp, cause });
        }
        if (row.allowed) break;
        signal?.throwIfAborted();
        const timestamp = failureNow();
        const waitMs = Math.max(1, timestampMs(row.retry_at) - timestamp);
        const remainingWaitMs = MAX_PACING_WAIT_MS - Math.max(waitedMs, performance.now() - startedAt);
        // Pacing denials never spend quota. Retry them briefly in-process, but
        // defer real quota exhaustion immediately so collectors retain cursors.
        // Independent bounds protect against clock skew and non-advancing test
        // clocks, even when the caller did not provide an AbortSignal.
        if (paced && row.reason === 'pacing' && waitMs <= remainingWaitMs && pacingRetries < MAX_PACING_RETRIES) {
          waitedMs += waitMs;
          pacingRetries++;
          await wait(waitMs, { signal });
          continue;
        }
        throw new MidgardBudgetDeferredError({ providerKey, reason: row.reason,
          retryAt: new Date(row.retry_at).toISOString(), now: timestamp });
      }
      let canceled = false;
      const receipt = {
        async cancel() {
          if (canceled) return;
          canceled = true;
          // A cancellation before fetch refunds only matching windows. If the
          // database is unavailable, conservatively retain the reservation.
          await client.query('select refund_midgard_request_budget($1, $2, $3::timestamptz)',
            [providerKey, budgetClass === 'bulk', row.reserved_at]).catch(() => {});
        }
      };
      if (signal?.aborted) {
        await receipt.cancel();
        signal.throwIfAborted();
      }
      return receipt;
    }
  };
}

export const midgardRequestBudget = config.midgardRequestBudgetEnabled
  ? createMidgardRequestBudget({
    client: { async query(text, values) {
      const { pool } = await import('../db/pool.js');
      return pool.query({ text, values, query_timeout: 3_000 });
    } },
    total: config.midgardRequestBudgetTotal,
    bulk: config.midgardRequestBudgetBulk,
    portal: {
      total: config.midgardPortalRequestBudgetTotal,
      bulk: config.midgardPortalRequestBudgetBulk,
      minIntervalMs: config.midgardPortalRequestMinIntervalMs
    }
  }) : null;
