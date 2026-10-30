import { recordAcquisitionMetric } from '../lib/acquisition-metrics.js';

const BUCKET_MS = 300_000;
const RETRY_MS = 30_000;
const PAGE_TTL_MS = 60_000;
const MAX_PAGES = 64;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const HEALTH_METRIC = 'financials:midgard-health';
const PAGE_METRIC = 'financials:midgard-scan-page';

function healthExpiry(payload, observedAt) {
  const timestamp = Number(payload?.lastAggregated?.timestamp) * 1000;
  const height = Number(payload?.lastAggregated?.height);
  const nextBucket = (Math.floor(timestamp / BUCKET_MS) + 1) * BUCKET_MS;
  // Only a healthy current watermark proves that no new usable five-minute
  // bucket can exist yet. Delayed/unhealthy/malformed sources retain fast polls.
  return payload?.database === true && payload.inSync === true
    && Number.isSafeInteger(height) && height > 0 && timestamp > 0
    && timestamp <= observedAt && nextBucket > observedAt
    ? Math.min(observedAt + BUCKET_MS, nextBucket) : observedAt + RETRY_MS;
}

function errorExpiry(error, observedAt) {
  const seconds = Number(error?.retryAfterSeconds);
  return Math.max(observedAt + RETRY_MS,
    Date.parse(error?.retryAt) || 0, Date.parse(error?.blockedUntil) || 0,
    Number.isFinite(seconds) && seconds > 0 ? observedAt + seconds * 1000 : 0);
}

const cancelled = (error, signal) => signal?.aborted || error?.name === 'AbortError'
  || error?.code === 'MIDGARD_BUDGET_ABORTED';
const usable = (entry, at) => entry && at >= entry.observedAt && at < entry.expiresAt;

function scanIdentity(path) {
  if (typeof path !== 'string' || !path.startsWith('/actions?') || path.includes('#') || path.includes('\\')) return null;
  const params = new URL(path, 'https://midgard.invalid').searchParams;
  const keys = [...params.keys()];
  if (keys.length !== 3 || new Set(keys).size !== 3
    || params.get('type') !== 'swap' || params.get('limit') !== '50') return null;
  if (params.has('timestamp') && /^\d{1,16}$/.test(params.get('timestamp'))
    && Number.isSafeInteger(Number(params.get('timestamp'))) && Number(params.get('timestamp')) > 0) {
    return `timestamp:${params.get('timestamp')}`;
  }
  const token = params.get('nextPageToken');
  return token && token.length <= 4096 ? `cursor:${token}` : null;
}

function pageBytes(payload, key) {
  if (!Array.isArray(payload?.actions) || payload.actions.length > 50) return 0;
  let previous = null;
  for (const action of payload.actions) {
    if (action?.type !== 'swap' || !/^\d+$/.test(String(action.date)) || BigInt(action.date) <= 0n) return 0;
    const date = BigInt(action.date);
    if (previous !== null && date > previous) return 0;
    previous = date;
  }
  const next = payload?.meta?.nextPageToken;
  if (next != null && typeof next !== 'string' || key.startsWith('cursor:') && next === key.slice(7)) return 0;
  try { return Buffer.byteLength(JSON.stringify(payload)) + Buffer.byteLength(key); }
  catch { return 0; }
}

// Cancellation belongs to each waiter. The initiating caller's existing signal
// still owns transport cancellation; a canceled joiner cannot abort its peers.
function waitFor(promise, signal, onAbort) {
  if (!signal) return promise.then(value => structuredClone(value));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { onAbort?.(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(structuredClone(value));
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Per-provider-composition cache. Nothing is shared across configured sources,
 * and all misses retain the existing transport, admission and cooldown hooks. */
export function createFinancialsRequestCache({ now = Date.now } = {}) {
  let health = null, bytes = 0;
  const healthFailures = new Map(), healthFlights = new Map(), pages = new Map(), pageFlights = new Map();
  function removePage(key) {
    const entry = pages.get(key);
    if (entry) bytes -= entry.bytes;
    pages.delete(key);
  }
  function fetchShared(flights, key, load, signal, metric, save, failed) {
    let flight = flights.get(key);
    if (flight) recordAcquisitionMetric(metric, 'coalesced');
    else {
      recordAcquisitionMetric(metric, 'miss');
      flight = { signal };
      flights.set(key, flight);
      const current = flight;
      flight.promise = Promise.resolve().then(load).then(payload => {
        signal?.throwIfAborted();
        if (flights.get(key) === current) save(payload, Number(now()));
        return payload;
      }, error => {
        if (flights.get(key) === current && !cancelled(error, signal)) failed?.(error, Number(now()));
        throw error;
      }).finally(() => { if (flights.get(key) === current) flights.delete(key); });
    }
    const current = flight;
    return waitFor(flight.promise, signal, () => {
      if (current.signal === signal && flights.get(key) === current) flights.delete(key);
    });
  }
  return (path, { service = 'midgard', midgardBudgetClass, signal } = {}, load) => {
    signal?.throwIfAborted();
    if (service !== 'midgard') return load();
    const at = Number(now());
    if (path === '/health') {
      if (usable(health, at)) {
        recordAcquisitionMetric(HEALTH_METRIC, 'hit');
        return Promise.resolve(structuredClone(health.payload));
      }
      // Bulk exhaustion must never pause a live caller with available capacity.
      const admission = midgardBudgetClass === 'bulk' ? 'bulk' : 'live';
      const failure = healthFailures.get(admission);
      if (usable(failure, at)) {
        recordAcquisitionMetric(HEALTH_METRIC, 'hit');
        return Promise.reject(failure.error);
      }
      return fetchShared(healthFlights, admission, load, signal, HEALTH_METRIC, (payload, observedAt) => {
        health = { payload: structuredClone(payload), observedAt, expiresAt: healthExpiry(payload, observedAt) };
        healthFailures.delete(admission);
      }, (error, observedAt) => {
        healthFailures.set(admission, { error, observedAt, expiresAt: errorExpiry(error, observedAt) });
      });
    }
    const key = scanIdentity(path);
    if (!key) return load();
    for (const [savedKey, entry] of pages) if (!usable(entry, at)) removePage(savedKey);
    const cached = pages.get(key);
    if (cached) {
      pages.delete(key); pages.set(key, cached);
      recordAcquisitionMetric(PAGE_METRIC, 'hit');
      return Promise.resolve(structuredClone(cached.payload));
    }
    if (!pageFlights.has(key) && pageFlights.size >= MAX_PAGES) return load();
    return fetchShared(pageFlights, key, load, signal, PAGE_METRIC, (payload, observedAt) => {
      const size = pageBytes(payload, key);
      if (!size || size > MAX_PAGE_BYTES) return;
      while (pages.size >= MAX_PAGES || bytes + size > MAX_PAGE_BYTES) removePage(pages.keys().next().value);
      pages.set(key, { payload: structuredClone(payload), observedAt, expiresAt: observedAt + PAGE_TTL_MS, bytes: size });
      bytes += size;
    });
  };
}
