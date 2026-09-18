import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ageComparisonPayload, COMPARISON_REFRESH_MS, hasComparisonData } from '../shared/protocol-fee-comparison/model.js';
import { buildComparisonPayload, collectComparison, emptyComparisonCache } from '../backend/src/protocol-fee-comparison/collector.js';
import { comparisonRequest } from '../backend/src/jobs/protocol-fee-comparison.js';

export const comparisonCacheFile = fileURLToPath(new URL('../node_modules/.cache/protocol-fee-comparison/state.json', import.meta.url));
export async function readComparisonCache(cacheFile = comparisonCacheFile) {
  try { return JSON.parse(await readFile(cacheFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { cache: emptyComparisonCache(), payload: null }; }
}
export async function saveComparisonCache(cache, payload, cacheFile = comparisonCacheFile) {
  // Acquisition checkpoints must not erase the last published snapshot.
  if (payload === undefined) payload = (await readComparisonCache(cacheFile)).payload;
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(`${cacheFile}.tmp`, JSON.stringify({ cache, payload }));
  await rename(`${cacheFile}.tmp`, cacheFile);
}

export function createProtocolFeeComparisonDevPlugin() {
  let timer, stopped = false, running;
  return {
    name: 'protocol-fee-comparison-dev-data', apply: 'serve',
    configureServer(server) {
      // GET remains read-only. Only the server-owned cadence runs acquisition.
      async function refresh() {
        if (stopped) return;
        try {
          const saved = await readComparisonCache();
          if (!saved.payload?.asOf || Date.now() - Date.parse(saved.payload.asOf) >= COMPARISON_REFRESH_MS) {
            running = collectComparison({ cache: saved.cache, request: comparisonRequest(),
              save: saveComparisonCache, log: (message) => server.config.logger.info(`[protocol comparison] ${message}`) });
            await running;
          }
        } catch (error) { server.config.logger.error(`[protocol comparison] ${error.message}`); }
        finally { running = null; if (!stopped) { timer = setTimeout(refresh, COMPARISON_REFRESH_MS); timer.unref(); } }
      }
      void refresh();
      server.httpServer?.once('close', () => { stopped = true; clearTimeout(timer); });
      server.middlewares.use(async (req, res, next) => {
        if (new URL(req.url, 'http://localhost').pathname !== '/__protocol-fee-comparison') return next();
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET required' })); return; }
        try {
          const saved = await readComparisonCache();
          const payload = saved.payload || buildComparisonPayload(saved.cache, { errors: ['Initial source backfill is running'] });
          if (!hasComparisonData(payload)) { res.statusCode = 503; res.end(JSON.stringify({ error: 'Monthly comparison is backfilling on-chain issuance. It will appear automatically.' })); return; }
          res.end(JSON.stringify(ageComparisonPayload(payload)));
        } catch (error) { res.statusCode = 502; res.end(JSON.stringify({ error: error.message })); }
      });
    },
    async closeBundle() { stopped = true; clearTimeout(timer); await running; }
  };
}
