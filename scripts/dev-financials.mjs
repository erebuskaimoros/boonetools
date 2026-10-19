import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { financialsWindow } from '../shared/financials/model.js';
import { createFinancialsService } from '../backend/src/shared/financials-service.js';
import { requestFromProviders } from '../shared/provider-client.js';
import { createProviderServices } from '../shared/provider-services.js';
import { advanceFinancialDay, financialDetailDay, financialDaySnapshotComplete, financialDayRetryAt,
  FINANCIAL_DAY_REFRESH_MS, FINANCIAL_DAY_VISITOR_LEASE_MS } from '../backend/src/shared/financials-day-detail.js';

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
  return (path, { service = 'midgard' } = {}) => {
    if (!['midgard', 'rpc'].includes(service)) throw new Error('Financials provider is not allowlisted');
    if (service === 'midgard') budget({ bulk: bulk || /^\/actions(?:[/?]|$)/.test(path) });
    return request(service, path, {
      timeoutMs: 60_000, providerMinIntervalMs: service === 'rpc' ? 650 : 1000,
      headers: { Accept: 'application/json', 'x-client-id': 'BooneTools-Financials' } });
  };
}

export function createFinancialsDayDevQueue({ requestJson = createFinancialsDevRequest(undefined, { bulk: true }), now = Date.now } = {}) {
  const days = new Map();
  let stopped = false;
  async function acquireDay(day, entry) {
    entry.running = true;
    try {
      for (let index = 0; index < 10 && !stopped && now() - entry.requestedAt < FINANCIAL_DAY_VISITOR_LEASE_MS; index++) {
        const result = await advanceFinancialDay(day, entry.state, requestJson, now());
        entry.state = result.state;
        if (result.payload) { entry.payload = result.payload; entry.retryAt = now() + FINANCIAL_DAY_REFRESH_MS; break; }
      }
      if (entry.state?.phase !== 'done') entry.retryAt = now() + 5000;
      entry.error = '';
    } catch (failure) { entry.error = failure.message; entry.retryAt = financialDayRetryAt(failure, now()); }
    finally { entry.running = false; }
  }
  return {
    read(day) {
      financialDetailDay(day, now());
      const entry = days.get(day) || { state: null, payload: null, running: false, retryAt: 0, error: '' };
      entry.requestedAt = now();
      days.set(day, entry);
      const complete = financialDaySnapshotComplete(day, entry.payload);
      if (!entry.running && !complete && now() >= entry.retryAt) entry.work = acquireDay(day, entry);
      return { day, ...entry.payload, loading: !entry.payload, refreshing: Boolean(entry.payload && entry.running && !complete),
        retryAt: !complete && entry.error ? new Date(entry.retryAt).toISOString() : null,
        deferred: Boolean(!complete && entry.error && entry.retryAt > now()), error: complete ? '' : entry.error,
        progress: { phase: complete ? 'done' : entry.state?.phase || (entry.payload ? 'done' : 'queued'), pages: entry.state?.pages || 0 } };
    },
    async idle() { await Promise.all([...days.values()].map(entry => entry.work)); },
    async stop() { stopped = true; await this.idle(); }
  };
}

export function createFinancialsDevPlugin() {
  let service;
  const days = createFinancialsDayDevQueue();
  return {
    name: 'financials-dev-data',
    apply: 'serve',
    configureServer(server) {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      service = createFinancialsService({ cacheDir: path.join(root, 'node_modules/.cache/financials'),
        requestJson: createFinancialsDevRequest(), rpcConcurrency: 6 });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/__financials') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET required' })); return; }
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
    async closeBundle() { await Promise.all([days.stop(), service?.stop()]); }
  };
}
