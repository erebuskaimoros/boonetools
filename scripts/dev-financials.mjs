import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { financialsWindow } from '../shared/financials/model.js';
import { createFinancialsService } from '../backend/src/shared/financials-service.js';
import { FINANCIALS_MIDGARD, FINANCIALS_RPC } from '../backend/src/shared/financials-history.js';
import { requestFromProviders } from '../shared/provider-client.js';
import { RPC_PUBLIC_URLS } from '../shared/thorchain-providers.js';
import { advanceFinancialDay, financialDetailDay } from '../backend/src/shared/financials-day-detail.js';

export function createFinancialsDevRequest(transport = requestFromProviders) {
  return (url) => {
    const base = [FINANCIALS_MIDGARD, FINANCIALS_RPC].find(candidate => url.startsWith(`${candidate}/`));
    if (!base) throw new Error('Financials provider is not allowlisted');
    return transport({ bases: base === FINANCIALS_RPC ? RPC_PUBLIC_URLS : [base], path: url.slice(base.length),
      timeoutMs: 60_000, providerMinIntervalMs: base === FINANCIALS_RPC ? 650 : 0,
      headers: { Accept: 'application/json', 'x-client-id': 'BooneTools-Financials' } });
  };
}

export function createFinancialsDevPlugin() {
  let service;
  const days = new Map();
  let stopped = false;
  const requestDay = createFinancialsDevRequest();
  async function acquireDay(day, entry) {
    entry.running = true;
    try {
      // Match the production request budget. Further browser polls resume the
      // checkpoint rather than leaving abandoned development scans running.
      for (let index = 0; index < 10 && !stopped; index++) {
        const result = await advanceFinancialDay(day, entry.state, route => requestDay(`${FINANCIALS_MIDGARD}${route}`));
        entry.state = result.state;
        if (result.payload) { entry.payload = result.payload; entry.state = null; entry.retryAt = Date.now() + 15 * 60_000; break; }
      }
      if (!entry.payload) entry.retryAt = Date.now() + 5000;
      entry.error = '';
    } catch (failure) { entry.error = failure.message; entry.retryAt = Date.now() + 60_000; }
    finally { entry.running = false; }
  }
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
          const entry = days.get(day) || { state: null, payload: null, running: false, retryAt: 0, error: '' };
          days.set(day, entry);
          if (!entry.running && !entry.payload?.finalized && Date.now() >= entry.retryAt) void acquireDay(day, entry);
          res.end(JSON.stringify({ day, ...entry.payload, loading: !entry.payload, refreshing: Boolean(entry.payload && entry.running),
            error: entry.error, progress: { phase: entry.state?.phase || (entry.payload ? 'done' : 'queued'), pages: entry.state?.pages || 0 } }));
          return;
        }
        const range = url.searchParams.get('range') || '30d';
        try { financialsWindow(range); } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); return; }
        try { res.end(JSON.stringify(await service.getHistory(range))); }
        catch (error) { res.statusCode = 502; res.end(JSON.stringify({ error: error.message })); }
      });
    },
    async closeBundle() { stopped = true; await service?.stop(); }
  };
}
