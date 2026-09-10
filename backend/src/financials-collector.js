import { closePool } from './db/pool.js';
import { runFinancialsCollector } from './jobs/financials.js';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

try {
  await runFinancialsCollector({ signal: controller.signal });
} catch (error) {
  console.error(JSON.stringify({ type: 'financials_collector_error', message: error.message }));
  process.exitCode = 1;
} finally { await closePool(); }
