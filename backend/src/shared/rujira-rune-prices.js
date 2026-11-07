import { loadAcquisition, saveAcquisition, acquisitionSourceKey } from './acquisition-cache.js';
import { fetchMidgard, MIDGARD_BASES } from './midgard.js';
import { setTimeout as waitForTimeout } from 'node:timers/promises';
import { config } from '../lib/config.js';
import { isProviderRateLimitError } from '../../../shared/provider-policy.js';

const NAMESPACE = 'midgard-rune-history:v1';
const DAY_MS = 86400000;
const OPEN_TTL_MS = 300000;
function day(value) { return new Date(value).toISOString().slice(0, 10); }
function startMs(value) { return Date.parse(`${day(value)}T00:00:00Z`); }
const MAX_RECOVERY_RETRIES = 2;
const MAX_RECOVERY_WAIT_MS = 120_000;

function retryDelay(error, nowMs) {
  if (String(error?.code || '').startsWith('MIDGARD_BUDGET_') || isProviderRateLimitError(error)
    || Number(error?.retryAfterSeconds) > 0) return null;
  if (error?.name === 'ProviderCooldownError' || error?.code === 'PROVIDER_COOLDOWN') {
    if (!String(error.providerKey || '').startsWith('service:')) return null;
    const expiry = Date.parse(error.blockedUntil);
    return Number.isFinite(expiry) ? Math.max(0, expiry - nowMs) : null;
  }
  const status = Number(error?.status);
  const transportFailure = error?.name === 'AbortError' || error?.name === 'TimeoutError'
    || error instanceof TypeError && /fetch failed|network|terminated/i.test(error.message);
  return status === 408 || status === 425 || status >= 500 || transportFailure
    ? Math.max(0, config.providerFailureCooldownMs) : null;
}

function validPrice(value) { return value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0; }

export async function loadRujiraRunePrices(client, starts, options = {}) {
  const currentTime = () => options.now ? new Date(typeof options.now === 'function' ? options.now() : options.now) : new Date();
  const now = currentTime();
  const nowMs = now.getTime();
  const interval = options.interval === 'week' ? 'week' : 'day';
  const width = interval === 'week' ? 7 * DAY_MS : DAY_MS;
  const base = (options.bases || MIDGARD_BASES)[0];
  const fetcher = options.fetchMidgard || fetchMidgard;
  const signal = options.signal || options.request?.signal;
  let recoveryRetries = 0, recoveryWaitMs = 0, requests = 0;
  // Share the recovery allowance across health and history ranges. Every retry
  // still enters normal provider availability and request-budget admission.
  async function request(route, settings) {
    while (true) {
      signal?.throwIfAborted();
      try {
        if (route.startsWith('/history/')) requests++;
        return await fetcher(route, { ...settings, ...(signal ? { signal } : {}) });
      } catch (error) {
        signal?.throwIfAborted();
        const delay = retryDelay(error, currentTime().getTime());
        if (delay === null || recoveryRetries >= MAX_RECOVERY_RETRIES
          || recoveryWaitMs + delay > MAX_RECOVERY_WAIT_MS) throw error;
        recoveryRetries++;
        recoveryWaitMs += delay;
        if (options.sleep) await options.sleep(delay, { signal });
        else await waitForTimeout(delay, undefined, { signal });
      }
    }
  }
  const load = options.loadCached || loadAcquisition;
  const save = options.saveCached || saveAcquisition;
  const wanted = [...new Set(starts.map(day))].sort().map((start) => ({
    start, end: day(startMs(start) + width), from: startMs(start), to: startMs(start) + width
  })).filter((bucket) => bucket.from <= nowMs);
  const rows = [];
  const missing = [];
  const errors = [];
  const identity = (bucket) => ({ provider: acquisitionSourceKey(base), interval, start: bucket.start, end: bucket.end });
  for (const bucket of wanted) {
    const cached = await load(client, NAMESPACE, identity(bucket), { nowMs, allowStale: false });
    const closed = bucket.to <= nowMs;
    if (cached && validPrice(cached.payload?.price) && (!closed || cached.completedAt)) {
      rows.push({ ...cached.payload, observedAt: cached.observedAt, completed: Boolean(cached.completedAt) });
    } else missing.push(bucket);
  }

  // Missing closed intervals are acquired in exact contiguous ranges. A gap
  // must never pull already completed neighboring buckets back from Midgard.
  const ranges = [];
  for (const bucket of missing) {
    const previous = ranges.at(-1);
    const closed = bucket.to <= nowMs;
    if (previous && previous.closed === closed && previous.to === bucket.from && previous.buckets.length < 400) {
      previous.buckets.push(bucket); previous.to = bucket.to;
    } else ranges.push({ from: bucket.from, to: bucket.to, closed, buckets: [bucket] });
  }
  const open = ranges.filter((range) => !range.closed);
  const closed = ranges.filter((range) => range.closed);
  const requestLimit = Math.max(1, Number(options.requestLimit) || 2);
  const available = Math.max(0, requestLimit - open.length);
  const offset = closed.length > available && available > 0 ? Math.floor(nowMs / OPEN_TTL_MS) % closed.length : 0;
  const selected = [...open, ...closed.slice(offset), ...closed.slice(0, offset)].slice(0, requestLimit);
  let watermark = 0;
  if (selected.some((range) => range.closed)) {
    try {
      const health = await request('/health', { bases: [base], cooldownClient: client,
        validateResponse: (_path, value) => !value || typeof value !== 'object' });
      const timestamp = Number(health.lastAggregated?.timestamp) * 1000;
      const receivedNowMs = options.healthNow ? new Date(options.healthNow).getTime() : currentTime().getTime();
      if (health.database !== true || health.inSync !== true || !(Number(health.lastAggregated?.height) > 0)
        || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > receivedNowMs) {
        throw new Error('Midgard aggregation watermark unavailable or not in sync');
      }
      watermark = timestamp;
    } catch (error) { signal?.throwIfAborted(); errors.push(error?.message || String(error)); }
  }
  for (const range of selected) {
    if (range.closed && watermark < range.to) {
      errors.push(`Midgard has not completed ${day(range.to - width)}`);
      continue;
    }
    try {
      const params = new URLSearchParams({ interval, from: String(range.from / 1000), to: String(range.to / 1000) });
      const payload = await request(`/history/rune?${params}`, { bases: [base], cooldownClient: client,
        validateResponse: (_path, value) => !Array.isArray(value?.intervals) });
      const byStart = new Map((payload.intervals || []).map((row) => [Number(row.startTime) * 1000, row]));
      for (const bucket of range.buckets) {
        const value = byStart.get(bucket.from);
        if (!value || Number(value.endTime) * 1000 !== bucket.to || !validPrice(value.runePriceUSD)) {
          errors.push(`Incomplete RUNE price ${interval} ${bucket.start}`);
          continue;
        }
        const observedAt = currentTime().toISOString();
        const row = { start: bucket.start, end: bucket.end, price: Number(value.runePriceUSD), source_json: value };
        await save(client, { namespace: NAMESPACE, identity: identity(bucket), payload: row,
          source: 'midgard:history/rune', observedAt,
          expiresAt: range.closed ? null : new Date(Date.parse(observedAt) + OPEN_TTL_MS).toISOString(),
          completedAt: range.closed ? observedAt : null,
          metadata: { interval, aggregated_through: watermark ? new Date(watermark).toISOString() : null }
        });
        rows.push({ ...row, observedAt, completed: range.closed });
      }
    } catch (error) { signal?.throwIfAborted(); errors.push(error?.message || String(error)); }
  }
  return { rows, requests, pending_buckets: wanted.length - rows.length, errors,
    recovery_retries: recoveryRetries, recovery_wait_ms: recoveryWaitMs };
}
