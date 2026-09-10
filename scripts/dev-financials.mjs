import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { financialsWindow } from '../shared/financials/model.js';
import { createFinancialsService } from '../backend/src/shared/financials-service.js';

export function createFinancialsDevPlugin() {
  let service;
  return {
    name: 'financials-dev-data',
    apply: 'serve',
    configureServer(server) {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      service = createFinancialsService({ cacheDir: path.join(root, 'node_modules/.cache/financials') });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/__financials') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET required' })); return; }
        const range = url.searchParams.get('range') || '30d';
        try { financialsWindow(range); } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); return; }
        try { res.end(JSON.stringify(await service.getHistory(range))); }
        catch (error) { res.statusCode = 502; res.end(JSON.stringify({ error: error.message })); }
      });
    },
    async closeBundle() { await service?.stop(); }
  };
}
