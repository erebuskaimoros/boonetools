import { createHash } from 'node:crypto';
import { config } from './config.js';

const WINDOWS = ['minute', 'hour', 'day'];

function normalizedBase(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v\d+$/i, '');
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
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
  return {
    base, path,
    providerKey: `midgard:${parsed.hostname.toLowerCase()}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
    budgetClass: options.midgardBudgetClass === 'bulk' || /^\/(?:v\d+\/)?actions\/?(?:[?#]|$)/.test(path) ? 'bulk' : 'live'
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
export function createMidgardRequestBudget({ client, total, bulk, now } = {}) {
  if (typeof client?.query !== 'function') throw new Error('Midgard budget requires an explicit database client');
  const totals = normalizedLimits(total), bulks = normalizedLimits(bulk);
  if (bulks.some((value, index) => value > totals[index])) throw new Error('Midgard bulk budget cannot exceed total budget');
  return {
    async claim({ providerKey, budgetClass = 'live', signal }) {
      signal?.throwIfAborted();
      const testNow = now ? new Date(now()).toISOString() : null;
      const failureNow = () => now ? Number(now()) : Date.now();
      let row;
      try {
        ({ rows: [row] } = await client.query(
          'select * from claim_midgard_request_budget($1, $2, $3::integer[], $4::integer[], $5::timestamptz)',
          [providerKey, budgetClass === 'bulk', totals, bulks, testNow]
        ));
        if (!row || typeof row.allowed !== 'boolean'
          || !Number.isFinite(Date.parse(row.allowed ? row.reserved_at : row.retry_at))) {
          throw new Error('Midgard budget returned an invalid reservation');
        }
      } catch (cause) {
        signal?.throwIfAborted();
        const timestamp = failureNow();
        throw new MidgardBudgetDeferredError({ providerKey, reason: 'storage-unavailable',
          retryAt: new Date(timestamp + 60_000).toISOString(), now: timestamp, cause });
      }
      if (!row.allowed) {
        signal?.throwIfAborted();
        throw new MidgardBudgetDeferredError({ providerKey, reason: row.reason,
          retryAt: new Date(row.retry_at).toISOString(), now: failureNow() });
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
    bulk: config.midgardRequestBudgetBulk
  }) : null;
