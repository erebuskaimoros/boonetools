import { withAdvisoryLock } from '../db/lock.js';
import { runPoolDislocationHistoricalBackfill } from '../shared/pool-dislocation-backfill.js';
import { runPoolDislocationScheduler } from './pool-dislocation-scheduler.js';

const LOCK_KEY = 'boonetools:pool-dislocation-backfill';

export async function runPoolDislocationBackfill(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  const result = await lockRunner(LOCK_KEY, (client) => (
    (options.backfill || runPoolDislocationHistoricalBackfill)(client, options)
  ));
  if (result?.skipped) return result;
  const refresh = await (options.refresh || runPoolDislocationScheduler)();
  return { ok: true, ...result, refresh };
}
