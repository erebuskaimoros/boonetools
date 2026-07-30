import { withAdvisoryLock } from '../db/lock.js';
import { config } from '../lib/config.js';
import {
  loadPoolDislocationRecentGapRepairPlan,
  runPoolDislocationHistoricalBackfill
} from '../shared/pool-dislocation-backfill.js';

const LOCK_KEY = 'boonetools:pool-dislocation-backfill';

export async function runPoolDislocationRepair(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  const result = await lockRunner(LOCK_KEY, (client) => (
    (options.repair || runPoolDislocationHistoricalBackfill)(client, {
      ...options,
      loadPlan: options.loadPlan || loadPoolDislocationRecentGapRepairPlan,
      lookbackHours: options.lookbackHours ?? config.poolDislocationRepairLookbackHours,
      maxBuckets: options.maxBuckets ?? config.poolDislocationRepairMaxBuckets,
      retryAttempts: options.retryAttempts ?? config.poolDislocationRepairRetryAttempts,
      retryBaseDelayMs: options.retryBaseDelayMs ?? config.poolDislocationRepairRetryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs ?? config.poolDislocationRepairRetryMaxDelayMs
    })
  ));
  if (result?.skipped) return result;
  return { ok: true, ...result };
}
