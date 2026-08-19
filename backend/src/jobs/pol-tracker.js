import { withAdvisoryLock } from '../db/lock.js';
import { config } from '../lib/config.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import { ingestPolTrackerHistory, shiftUtcDay } from '../shared/pol-tracker-backfill.js';
import {
  POL_TRACKER_MODEL_KEY,
  POL_TRACKER_SCHEMA_VERSION,
  POL_TRACKER_TTL_MS,
  buildPolTrackerReadModel,
  lastCompletedUtcDay
} from '../shared/pol-tracker.js';

const LOCK_KEY = 'boonetools:pol-tracker';

function maxDay(left, right) {
  return String(left) > String(right) ? String(left) : String(right);
}

function resolvedNow(value) {
  return typeof value === 'function' ? value() : value || new Date();
}

function readModelClock(value) {
  if (typeof value === 'function') return value;
  if (value) return () => new Date(value);
  return undefined;
}

async function ingestAndPublish(client, options = {}) {
  const ingestion = await (options.ingest || ingestPolTrackerHistory)(client, options);
  const publish = options.publish || buildAndPublishReadModel;
  const published = await publish({
    modelKey: POL_TRACKER_MODEL_KEY,
    schemaVersion: POL_TRACKER_SCHEMA_VERSION,
    ttlMs: POL_TRACKER_TTL_MS,
    client,
    now: readModelClock(options.now),
    build: () => (options.buildReadModel || buildPolTrackerReadModel)(client, options)
  });
  return { ...ingestion, published: Boolean(published?.ok ?? true) };
}

export async function runPolTrackerBackfill(options = {}) {
  const endDate = options.endDate || lastCompletedUtcDay(resolvedNow(options.now));
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(LOCK_KEY, (client) => ingestAndPublish(client, {
    ...options,
    startDate: options.startDate || config.polTrackerStartDate,
    endDate,
    retryPartial: options.retryPartial !== false
  }));
}

export async function runPolTrackerScheduler(options = {}) {
  const endDate = options.endDate || lastCompletedUtcDay(resolvedNow(options.now));
  const lookback = Math.max(1, Number(options.lookbackDays || config.polTrackerRecentLookbackDays));
  const startDate = options.startDate || maxDay(
    config.polTrackerStartDate,
    shiftUtcDay(endDate, -(lookback - 1))
  );
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(LOCK_KEY, (client) => ingestAndPublish(client, {
    ...options,
    startDate,
    endDate,
    retryPartial: true
  }));
}
