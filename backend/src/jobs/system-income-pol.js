import { config } from '../lib/config.js';
import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import {
  SYSTEM_INCOME_POL_MODEL_KEY,
  SYSTEM_INCOME_POL_SCHEMA_VERSION,
  SYSTEM_INCOME_POL_TTL_MS,
  buildSystemIncomePolReadModel
} from '../shared/system-income-pol.js';
import { reconcileSystemIncomePolState } from '../shared/system-income-pol-reconciliation.js';
import { repairSystemIncomePolBlocks } from '../shared/system-income-pol-repair.js';
import {
  compactSystemIncomePolEvents,
  refreshSystemIncomePolFeeEstimates,
  updateSystemIncomePolState
} from '../shared/system-income-pol-store.js';

const LOCK_KEY = 'boonetools:system-income-pol';

async function refresh(client, options = {}) {
  const activationHeight = options.activationHeight || config.systemIncomePolActivationHeight;
  try {
    const repairBatch = options.repair || repairSystemIncomePolBlocks;
    let repair = null;
    let repairedBlocks = 0;
    const maxBatches = Math.max(
      1,
      Math.trunc(Number(options.repairMaxBatches)) || config.systemIncomePolRepairMaxBatches
    );
    for (let batch = 0; batch < maxBatches; batch += 1) {
      repair = await repairBatch(client, { ...options, activationHeight });
      repairedBlocks += Math.max(0, Number(repair?.repaired) || 0);
      if (repair?.complete !== false) break;
    }
    if (repair?.complete === false) {
      throw new Error(`SIPOL activation backfill is incomplete through ${repair.headHeight}`);
    }
    repair = { ...(repair || {}), repaired: repairedBlocks };
    const compacted = await (options.compact || compactSystemIncomePolEvents)(client, {
      ...options,
      activationHeight
    });
    const reconciled = await (options.reconcile || reconcileSystemIncomePolState)(client, options);
    const fees = await (options.refreshFees || refreshSystemIncomePolFeeEstimates)(client, {
      ...options,
      activationHeight
    });
    const published = await (options.publish || buildAndPublishReadModel)({
      modelKey: SYSTEM_INCOME_POL_MODEL_KEY,
      schemaVersion: SYSTEM_INCOME_POL_SCHEMA_VERSION,
      ttlMs: SYSTEM_INCOME_POL_TTL_MS,
      client,
      now: typeof options.now === 'function'
        ? options.now
        : options.now
          ? () => new Date(options.now)
          : undefined,
      build: () => (options.buildReadModel || buildSystemIncomePolReadModel)(client, options)
    });
    return {
      repair,
      compacted,
      reconciled,
      fees,
      published: Boolean(published?.ok ?? true)
    };
  } catch (error) {
    await (options.updateState || updateSystemIncomePolState)(client, {
      activationHeight,
      lastError: error?.message || String(error),
      stats: { failed_at: new Date().toISOString() }
    }).catch(() => {});
    throw error;
  }
}

export async function runSystemIncomePolScheduler(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(LOCK_KEY, (client) => refresh(client, options));
}
