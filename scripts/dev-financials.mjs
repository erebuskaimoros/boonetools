import path from 'node:path';
import { financialsWindow } from '../shared/financials/model.js';
import { createFinancialsService } from '../backend/src/shared/financials-service.js';
import { createFinancialsHourlyService } from '../backend/src/shared/financials-hourly.js';
import { financialHourlyWindow } from '../shared/financials/hourly.js';
import { requestFromProviders } from '../shared/provider-client.js';
import { createProviderServices } from '../shared/provider-services.js';
import { createDevDataCache } from './dev-data-cache.mjs';
import { advanceFinancialDay, financialDetailDay, financialDaySnapshotComplete, financialDayRetryAt,
  financialDayNextWorkAt, financialDayNeedsWork, financialDaySettlement, financialDaySnapshotFinalized,
  financialDayRosterReadyAt, FINANCIAL_DAY_VISITOR_LEASE_MS } from '../backend/src/shared/financials-day-detail.js';

// Local development does not share the production database/quota counters.
// All Financials dev requests do share this process-local admission budget.
export function createFinancialsDevBudget({ now = Date.now } = {}) {
  const windows = [[60_000, 60, 30, 'minute'], [3600_000, 2000, 1000, 'hour'], [86400_000, 20000, 5000, 'day']];
  const counters = new Map();
  return ({ bulk = false } = {}) => {
    const timestamp = now();
    const checks = windows.flatMap(([duration, total, bulkLimit, period]) => {
      const start = Math.floor(timestamp / duration) * duration;
      return [['total', total], ...(bulk ? [['bulk', bulkLimit]] : [])].map(([kind, limit]) => {
        const key = `${period}:${kind}`;
        let count = counters.get(key);
        if (!count || count.start !== start) { count = { start, count: 0 }; counters.set(key, count); }
        return { count, limit, retryAt: start + duration, reason: `${kind}-${period}` };
      });
    });
    const blocked = checks.filter(check => check.count.count >= check.limit).sort((a, b) => b.retryAt - a.retryAt)[0];
    if (blocked) {
      const error = new Error(`Local Midgard ${blocked.reason} request budget reached; saved progress will resume later`);
      Object.assign(error, { code: 'MIDGARD_BUDGET_DEFERRED', name: 'MidgardBudgetDeferredError', skipProvider: true,
        retryAt: new Date(blocked.retryAt).toISOString(), blockedUntil: new Date(blocked.retryAt).toISOString(),
        retryAfterSeconds: Math.ceil((blocked.retryAt - timestamp) / 1000), budgetReason: blocked.reason });
      throw error;
    }
    for (const check of checks) check.count.count++;
  };
}

const devMidgardBudget = createFinancialsDevBudget();

export function createFinancialsDevRequest(transport = requestFromProviders, { budget = devMidgardBudget, bulk = false } = {}) {
  const request = createProviderServices({ transport });
  return (path, { service = 'midgard', signal } = {}) => {
    signal?.throwIfAborted();
    if (!['midgard', 'rpc'].includes(service)) throw new Error('Financials provider is not allowlisted');
    if (service === 'midgard') budget({ bulk: bulk || /^\/actions(?:[/?]|$)/.test(path) });
    return request(service, path, {
      timeoutMs: 60_000, providerMinIntervalMs: service === 'rpc' ? 650 : 1000,
      request: { signal },
      headers: { Accept: 'application/json', 'x-client-id': 'BooneTools-Financials' } });
  };
}

export function createFinancialsDayDevQueue({ requestJson = createFinancialsDevRequest(undefined, { bulk: true }), now = Date.now,
  maxRequests = 10, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const days = new Map();
  const controller = new AbortController();
  const batchSize = Math.max(1, Math.min(10, Number(maxRequests) || 10));
  let stopped = false, started = false, timer, active;
  const utcDay = timestamp => new Date(timestamp).toISOString().slice(0, 10);
  const leased = entry => entry.background || financialDaySettlement(entry.payload?.day, entry.payload)?.status === 'pending'
    || now() - entry.requestedAt < FINANCIAL_DAY_VISITOR_LEASE_MS;
  function ensureDay(day, background = false) {
    let entry = days.get(day);
    if (!entry) {
      entry = { state: null, payload: null, running: false, retryAt: background ? financialDayRosterReadyAt(day, now()) : 0,
        requestedAt: 0, lastWorkedAt: now(), background, error: '' };
      days.set(day, entry);
    } else if (background) entry.background = true;
    return entry;
  }
  async function acquireDay(day, entry) {
    entry.running = true;
    entry.lastWorkedAt = now();
    try {
      for (let index = 0; index < batchSize && !stopped && leased(entry); index++) {
        const result = await advanceFinancialDay(day, entry.state,
          (route, options) => requestJson(route, { ...options, signal: controller.signal }), now(), { background: entry.background });
        entry.state = result.state;
        if (result.payload) {
          entry.payload = result.payload;
          entry.retryAt = financialDayNextWorkAt(day, result.payload, now(), { background: entry.background }) ?? now();
          if (!financialDaySnapshotComplete(day, result.payload) || !financialDayNeedsWork(day, result.payload, now())) break;
        }
      }
      if (entry.state?.phase !== 'done' || (financialDaySnapshotComplete(day, entry.payload)
        && financialDayNeedsWork(day, entry.payload, now()))) entry.retryAt = now() + 5000;
      entry.error = '';
    } catch (failure) {
      if (!stopped) { entry.error = failure.message; entry.retryAt = financialDayRetryAt(failure, now()); }
    }
    finally { entry.running = false; }
  }
  function run(day, entry) {
    if (stopped || active || !leased(entry) || !financialDayNeedsWork(day, entry.payload, now()) || now() < entry.retryAt) return active;
    active = acquireDay(day, entry).finally(() => { active = null; });
    return active;
  }
  function schedule(delay) {
    timer = setTimer(async () => {
      timer = undefined;
      try { await queue.tick(); }
      finally { if (!stopped) schedule(5000); }
    }, delay);
    timer?.unref?.();
  }
  const queue = {
    read(day) {
      financialDetailDay(day, now());
      const entry = ensureDay(day, day === utcDay(now()));
      entry.requestedAt = now();
      const complete = financialDaySnapshotComplete(day, entry.payload);
      run(day, entry);
      const settlement = financialDaySettlement(day, entry.payload);
      const working = !complete || settlement?.status === 'pending';
      if (settlement?.status === 'pending') {
        const eligibleAt = Math.max(Date.parse(settlement.nextCheckAt) || 0, entry.retryAt);
        if (eligibleAt > now()) settlement.nextCheckAt = new Date(eligibleAt).toISOString();
      }
      return { day, ...entry.payload, loading: !entry.payload, refreshing: Boolean(entry.payload && entry.running && !complete),
        ...(complete ? { finalized: financialDaySnapshotFinalized(day, entry.payload, now()), settlement } : {}),
        retryAt: working && entry.error ? new Date(entry.retryAt).toISOString() : null,
        deferred: Boolean(working && entry.error && entry.retryAt > now()), error: working ? entry.error : '',
        progress: { phase: settlement?.status === 'pending' ? 'settlement' : complete ? 'done' : entry.state?.phase || (entry.payload ? 'done' : 'queued'), pages: entry.state?.pages || 0 } };
    },
    async tick() {
      if (stopped) return;
      ensureDay(utcDay(now()), true);
      const yesterday = utcDay(now() - 86400_000);
      if (days.has(yesterday) && !financialDaySnapshotComplete(yesterday, days.get(yesterday).payload)) ensureDay(yesterday, true);
      for (const [day, entry] of days) if (financialDaySettlement(day, entry.payload)?.status === 'pending') entry.background = true;
      if (active) return active;
      // A single bounded batch at a time. Rotate eligible days by their last
      // work time so cold visitor scans cannot starve the maintained roster.
      const next = [...days].filter(([day, entry]) => leased(entry) && financialDayNeedsWork(day, entry.payload, now()) && now() >= entry.retryAt)
        .sort(([dayA, a], [dayB, b]) => a.lastWorkedAt - b.lastWorkedAt || dayA.localeCompare(dayB))[0];
      if (next) await run(...next);
    },
    start() { if (!started && !stopped) { started = true; schedule(0); } },
    async idle() { await active; },
    async stop() { stopped = true; clearTimer(timer); timer = undefined; controller.abort(); await queue.idle(); }
  };
  return queue;
}

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);

// Observations live in the checkout's ignored .boonetools-cache, which `npm ci`
// leaves alone; the first run migrates any history npm has not yet removed.
export function createFinancialsDevPlugin({ root, cacheDir, days = createFinancialsDayDevQueue(),
  createService = createFinancialsService, createHourlyService = createFinancialsHourlyService } = {}) {
  const historyCache = createDevDataCache('financials/history-v1.json', { root,
    validate: stored => stored?.version === 1 && [stored.swaps, stored.earnings, stored.bonds].every(isRecord) });
  const hourlyCache = createDevDataCache('financials/hourly-v1.json', { root,
    validate: stored => stored?.version === 1 && [stored.swaps, stored.earnings].every(isRecord) });
  cacheDir ??= path.dirname(historyCache.file);
  let service, hourly, stopping;
  const stop = () => stopping ||= Promise.all([days.stop(), service?.stop(), hourly?.stop()]);
  return {
    name: 'financials-dev-data',
    apply: 'serve',
    async configureServer(server) {
      // Migrate, or refuse unusable observations, before any acquisition starts.
      await historyCache.prepare(path.join(cacheDir, 'history-v1.json'));
      await hourlyCache.prepare(path.join(cacheDir, 'hourly-v1.json'));
      service = createService({ cacheDir, requestJson: createFinancialsDevRequest(), rpcConcurrency: 6 });
      hourly = createHourlyService({ cacheDir, requestJson: createFinancialsDevRequest() });
      days.start();
      server.httpServer?.once('close', stop);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/__financials') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET required' })); return; }
        if (url.searchParams.has('bucket') && !['hour', 'day'].includes(url.searchParams.get('bucket'))) {
          res.statusCode = 400; res.end(JSON.stringify({ error: 'Bucket must be hour or day' })); return;
        }
        if (url.searchParams.get('bucket') === 'hour') {
          const range = url.searchParams.get('range') || '24h';
          try {
            if (url.searchParams.has('day')) throw new Error('Day details use daily buckets');
            financialHourlyWindow(range);
          } catch (failure) { res.statusCode = 400; res.end(JSON.stringify({ error: failure.message })); return; }
          // Serve cached observations immediately while one bounded fill runs.
          void hourly.refresh();
          res.end(JSON.stringify(await hourly.getSnapshot(range))); return;
        }
        if (url.searchParams.has('day')) {
          const day = url.searchParams.get('day');
          try { financialDetailDay(day); } catch (failure) { res.statusCode = 400; res.end(JSON.stringify({ error: failure.message })); return; }
          res.end(JSON.stringify(days.read(day)));
          return;
        }
        const range = url.searchParams.get('range') || '30d';
        try { financialsWindow(range); } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); return; }
        try { res.end(JSON.stringify(await service.getHistory(range))); }
        catch (error) { res.statusCode = 502; res.end(JSON.stringify({ error: error.message })); }
      });
    },
    async closeBundle() { await stop(); }
  };
}
