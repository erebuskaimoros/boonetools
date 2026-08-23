import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import { ingestBurnTrackerHistory } from '../shared/burn-tracker-ingestion.js';
import {
  BURN_TRACKER_MODEL_KEY,
  BURN_TRACKER_SCHEMA_VERSION,
  BURN_TRACKER_TTL_MS,
  buildBurnTrackerReadModel
} from '../shared/burn-tracker.js';

const LOCK_KEY = 'boonetools:system-income-burn';

async function ingestAndPublish(client, options = {}) {
  const ingestion = await (options.ingest || ingestBurnTrackerHistory)(client, options);
  const published = await (options.publish || buildAndPublishReadModel)({
    modelKey: BURN_TRACKER_MODEL_KEY,
    schemaVersion: BURN_TRACKER_SCHEMA_VERSION,
    ttlMs: BURN_TRACKER_TTL_MS,
    client,
    now: typeof options.now === 'function' ? options.now : options.now ? () => new Date(options.now) : undefined,
    build: () => (options.buildReadModel || buildBurnTrackerReadModel)(client, options)
  });
  return { ...ingestion, published: Boolean(published?.ok ?? true) };
}

export async function runBurnTrackerBackfill(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(LOCK_KEY, (client) => ingestAndPublish(client, { ...options, full: true }));
}

export async function runBurnTrackerScheduler(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(LOCK_KEY, (client) => ingestAndPublish(client, options));
}
