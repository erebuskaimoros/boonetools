import { LIQUIFY_THORNODE, LIQUIFY_RPC, NATIVESWAP_THORNODE, NATIVESWAP_RPC } from './thorchain-providers.js';
import { ProviderCooldownError, providerCooldownKeys, isProviderRateLimitError,
  isProviderGatewayRateLimitError, shouldRecordServiceFailure } from './provider-policy.js';

const RPC_READS = new Set(['status', 'block', 'block_results', 'blockchain', 'abci_query', 'tx', 'tx_search', 'block_search']);
const normalize = (base) => String(base || '').replace(/\/+$/, '');
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function familyOf(base) {
  if ([NATIVESWAP_THORNODE, '/__thornode_fallback', '/__thornode_primary', LIQUIFY_THORNODE].includes(base)) return 'api';
  if ([NATIVESWAP_RPC, LIQUIFY_RPC].includes(base)) return 'rpc';
  return null;
}

function isLiquify(base, family) {
  if (base === '/__thornode_primary') return family === 'api';
  try {
    const url = new URL(base);
    return url.hostname === 'gateway.liquify.com'
      && (url.pathname.startsWith('/api=')
        || url.pathname === `/chain/thorchain_${family === 'api' ? 'api' : 'rpc'}`);
  } catch { return false; }
}

export function hasThorchainProviderPair(bases = []) {
  return Boolean(providerPair(bases.map(normalize)));
}

function providerPair(bases) {
  const native = bases.find((base) => [NATIVESWAP_THORNODE, NATIVESWAP_RPC, '/__thornode_fallback'].includes(base));
  const family = familyOf(native);
  const liquify = native && bases.find((base) => isLiquify(base, family));
  return liquify ? { native, liquify, family } : null;
}

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function searchBounds(query) {
  // GET query values are JSON-quoted; POST values are already plain strings.
  try { if (String(query).startsWith('"')) query = JSON.parse(query); } catch { return null; }
  // Ignore quoted event values so text such as memo='tx.height>100' cannot
  // accidentally opt an unbounded search into a pruned provider.
  query = String(query).replace(/'[^']*'/g, "''");
  // OR/NOT can describe a disjoint or wider range. Do not infer retained
  // coverage from just one of its clauses.
  if (/\b(?:OR|NOT)\b/i.test(query)) return null;
  let min = 0, max = Infinity;
  for (const clause of query.split(/\bAND\b/i)) {
    const match = clause.match(/^\s*(?:tx|block)\.height\s*(>=|<=|=|>|<)\s*(\d+)\s*$/);
    if (!match) continue;
    const value = positive(match[2]);
    if (['>=', '>', '='].includes(match[1])) min = Math.max(min, value + Number(match[1] === '>'));
    if (['<=', '<', '='].includes(match[1])) max = Math.min(max, value - Number(match[1] === '<'));
  }
  return min && min <= max ? { min, max } : null;
}

function callBounds(method, params = {}) {
  if (method === 'tx_search' || method === 'block_search') return searchBounds(params.query || '');
  if (method === 'blockchain') {
    const min = positive(params.minHeight), max = positive(params.maxHeight) || Infinity;
    return min && min <= max ? { min, max } : null;
  }
  const height = positive(params.height);
  return { min: height, max: height || Infinity };
}

function requestShape(options, family) {
  const url = new URL(options.path || '/', 'https://provider.invalid');
  const method = String(options.request?.method || 'GET').toUpperCase();
  if (family === 'api') {
    const headers = typeof options.headers === 'function' ? options.headers({ base: options.bases[0], path: options.path }) : options.headers;
    const historical = url.searchParams.has('height')
      || header(options.request?.headers, 'x-cosmos-block-height') || header(headers, 'x-cosmos-block-height');
    return { read: method === 'GET' && /^\/(?:thorchain|cosmos|cosmwasm|schedules)(?:\/|$)/.test(url.pathname), historical };
  }
  let calls;
  if (method === 'GET') calls = [{ method: url.pathname.replace(/^\//, ''), params: Object.fromEntries(url.searchParams) }];
  else if (method === 'POST' && url.pathname === '/') {
    try {
      const body = JSON.parse(options.request.body);
      calls = Array.isArray(body) ? body : [body];
    } catch { return { read: false }; }
  }
  if (!calls?.length || calls.some((call) => !RPC_READS.has(call?.method))) return { read: false };
  const ranges = calls.map((call) => callBounds(call.method, call.params));
  return { read: true, calls, ranges, statusOnly: calls.every((call) => call.method === 'status') };
}

function validatedRange(payload, now) {
  const sync = payload?.result?.sync_info;
  const earliest = positive(sync?.earliest_block_height), latest = positive(sync?.latest_block_height);
  const time = Date.parse(sync?.latest_block_time);
  if (payload?.result?.node_info?.network !== 'thorchain-1' || sync?.catching_up !== false
    || !earliest || latest < earliest || !Number.isFinite(time) || time > now + 30_000 || now - time > 90_000) {
    throw new Error('NativeSwap RPC is not a fresh, synced THORChain mainnet provider');
  }
  return { earliest, latest };
}

// A process/browser-local queue controls concurrent requests; backend hooks
// additionally enforce durable, cross-process cooldowns. Work is distributed,
// never duplicated/hedged. Each HTTP JSON-RPC batch is one queue item.
export function createThorchainProviderPool({ maxConcurrent = 4, maxQueued = 256,
  failureCooldownMs = 60_000, rateLimitCooldownMs = 3_600_000,
  statusTtlMs = 60_000, startIndex = 0, now = Date.now } = {}) {
  const lanes = new Map(), breakers = new Map(), cursors = new Map();
  let rangeCache = null, rangePending = null, rangeRetryAt = 0;
  maxConcurrent = Math.max(1, Math.min(16, Math.trunc(maxConcurrent) || 4));

  const managed = (base) => Boolean(familyOf(normalize(base))) || isLiquify(normalize(base), 'api') || isLiquify(normalize(base), 'rpc');

  function assertAvailable(base, scope = '', enabled = true) {
    if (!enabled) return;
    for (const key of Object.values(providerCooldownKeys(base, { scope }))) {
      const until = breakers.get(key);
      if (until > now()) throw new ProviderCooldownError(key, new Date(until).toISOString());
      if (until) breakers.delete(key);
    }
  }

  function failure(base, error, scope = '', enabled = true) {
    if (!enabled || !managed(base) || !shouldRecordServiceFailure(error)) return;
    const keys = providerCooldownKeys(base, { scope });
    const key = isProviderGatewayRateLimitError(error) ? keys.global : keys.service;
    const duration = Math.max(isProviderRateLimitError(error) ? rateLimitCooldownMs : failureCooldownMs,
      (Number(error?.retryAfterSeconds) || 0) * 1000);
    breakers.set(key, Math.max(breakers.get(key) || 0, now() + duration));
  }

  /** @param {string} base
   * @param {{signal?: AbortSignal, scope?: string, cooldown?: boolean, minIntervalMs?: number}} options */
  async function acquire(base, { signal, scope = '', cooldown = true, minIntervalMs = 0 } = {}) {
    signal?.throwIfAborted();
    if (!managed(base)) return () => {};
    assertAvailable(base, scope, cooldown);
    const key = providerCooldownKeys(base).global;
    if (!lanes.has(key)) lanes.set(key, { active: 0, waiting: [], nextStart: 0 });
    const lane = lanes.get(key);
    if (lane.active >= maxConcurrent) {
      if (lane.waiting.length >= maxQueued) throw Object.assign(new Error('Provider request queue is full'), { skipProvider: true });
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, abort: null };
        entry.abort = () => {
          const index = lane.waiting.indexOf(entry);
          if (index >= 0) lane.waiting.splice(index, 1);
          reject(signal.reason);
        };
        lane.waiting.push(entry);
        signal?.addEventListener('abort', entry.abort, { once: true });
      });
    } else lane.active++;
    // A release transfers its reserved slot to the next waiter. Recheck both
    // cancellation and cooldown after admission, not just when enqueued.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = lane.waiting.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.abort);
        next.resolve();
      } else lane.active--;
    };
    try {
      if (minIntervalMs > 0) {
        const start = Math.max(now(), lane.nextStart);
        lane.nextStart = start + minIntervalMs;
        const waitMs = start - now();
        if (waitMs > 0) await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, waitMs);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      signal?.throwIfAborted(); assertAvailable(base, scope, cooldown);
    }
    catch (error) { release(); throw error; }
    return release;
  }

  async function nativeRange(options, probe) {
    if (rangeCache?.expires > now()) return rangeCache.value;
    if (rangeRetryAt > now()) return null;
    if (!rangePending) rangePending = (async () => {
      let release;
      try {
        release = await acquire(NATIVESWAP_RPC, { signal: options.request?.signal,
          scope: options.providerScope, cooldown: options.providerCooldownEnabled !== false });
        const payload = await probe(NATIVESWAP_RPC);
        const value = validatedRange(payload, now());
        rangeCache = { value, expires: now() + statusTtlMs };
        return value;
      } catch (error) {
        if (!options.request?.signal?.aborted) {
          failure(NATIVESWAP_RPC, error, options.providerScope, options.providerCooldownEnabled !== false);
          rangeRetryAt = now() + failureCooldownMs;
        }
        return null;
      } finally { release?.(); rangePending = null; }
    })();
    return rangePending;
  }

  async function order(options, probe) {
    const bases = options.bases.map(normalize);
    const pair = providerPair(bases);
    // Explicit single-provider pins and non-THORChain transports retain their
    // ordering; never append unconfigured providers or split coherent snapshots.
    if (!pair || options.providerMode === 'fallback') return bases;
    const shape = requestShape(options, pair.family);
    if (!shape.read) return bases;
    // REST historical-height behavior is endpoint-specific. Preserve existing
    // ordered fallback and domain validation, but do not actively distribute it.
    if (shape.historical) return bases;
    if (pair.family === 'rpc' && !shape.statusOnly) {
      if (shape.ranges.some((range) => !range)) return bases.filter((base) => base !== pair.native);
      const retained = await nativeRange(options, probe);
      if (!retained || shape.ranges.some((range) => range.min && (range.min < retained.earliest
        || range.min > retained.latest || Number.isFinite(range.max) && range.max > retained.latest))) {
        return bases.filter((base) => base !== pair.native);
      }
    }
    const cursor = cursors.get(pair.family) ?? startIndex;
    cursors.set(pair.family, cursor + 1);
    const peers = cursor % 2 ? [pair.native, pair.liquify] : [pair.liquify, pair.native];
    return [...peers, ...bases.filter((base) => !peers.includes(base))];
  }

  function validate(options, base, payload) {
    const family = familyOf(normalize(base)) || (isLiquify(normalize(base), 'rpc') ? 'rpc' : null);
    // Dedicated endpoints have no service in their path; the configured peer
    // determines their family. API responses can legitimately contain `error`.
    const pairFamily = providerPair(options.bases.map(normalize))?.family;
    if ((pairFamily || family) !== 'rpc' || options.responseType === 'response' || options.responseType === 'text') return null;
    const shape = requestShape(options, 'rpc');
    if (!shape.read) return null;
    const entries = Array.isArray(payload) ? payload : [payload];
    const batchError = !Array.isArray(payload) && payload?.error;
    const errors = [];
    for (const call of shape.calls) {
      const entry = call.id == null ? entries[0] : entries.find((value) => String(value?.id) === String(call.id));
      if (!entry || entry.error) {
        const rpcError = entry?.error || batchError;
        errors.push([rpcError?.message, rpcError?.data].filter(Boolean).join(': ') || 'Missing JSON-RPC batch result');
        continue;
      }
      const height = positive(call.params?.height);
      const returnedHeight = entry.result?.height || entry.result?.block?.header?.height || entry.result?.response?.height;
      if (height && returnedHeight != null && Number(returnedHeight) !== height) { errors.push('RPC returned a different block height'); continue; }
      if (Number(entry.result?.response?.code) > 0) errors.push(entry.result.response.log || 'ABCI query failed');
    }
    // Mixed batches retain their valid observations for the collector's
    // existing per-height validation/persistence. A wholly failed request
    // falls through to the other provider immediately.
    if (errors.length !== shape.calls.length) return null;
    const error = new Error(errors[0]);
    // Pruned historical state is a request-specific miss, not evidence that
    // this provider's current-height service is unhealthy.
    if (/no archive|version does not exist|(?:height|block).*?(?:unavailable|not available|not found|pruned)|lowest height|height must be (?:less|greater)/i.test(error.message)) {
      Object.assign(error, { skipProvider: true });
    }
    return error;
  }

  return { now, order, acquire, failure, validate };
}

export const thorchainProviderPool = createThorchainProviderPool();
