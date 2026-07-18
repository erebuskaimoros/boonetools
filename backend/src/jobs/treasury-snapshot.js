import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel, getReadModel } from '../shared/read-models.js';
import {
  TREASURY_SNAPSHOT_MODEL_KEY,
  TREASURY_SNAPSHOT_SCHEMA_VERSION,
  TREASURY_SNAPSHOT_TTL_MS,
  buildTreasurySnapshot
} from '../shared/treasury-snapshot.js';

const LOCK_KEY = 'boonetools:treasury-snapshot';

export async function buildTreasurySnapshotReadModel(options = {}) {
  const client = options.client;
  const previousModel = await (options.getReadModel || getReadModel)(
    TREASURY_SNAPSHOT_MODEL_KEY,
    { client, allowStale: true }
  );
  const payload = await (options.buildSnapshot || buildTreasurySnapshot)({
    previousSnapshot: previousModel?.payload || null,
    providers: options.providers,
    providerOptions: options.providerOptions,
    now: options.now
  });

  return {
    payload,
    generatedAt: payload.as_of,
    sourceUpdatedAt: payload.source_updated_at,
    metadata: {
      partial: payload.partial,
      warnings: payload.warnings,
      segment_health: payload.segment_health
    },
    stats: {
      entries: payload.sections.flatMap((section) => section.entries).length,
      balances: payload.sections.flatMap((section) => section.entries)
        .reduce((total, entry) => total + entry.balances.length, 0),
      lp_positions: payload.sections.flatMap((section) => section.entries)
        .reduce((total, entry) => total + entry.lpPositions.length, 0),
      bonds: payload.sections.flatMap((section) => section.entries)
        .reduce((total, entry) => total + entry.bonds.length, 0),
      unpriced_balances: payload.unpricedBalanceCount,
      warnings: payload.warnings.length,
      reused_segments: payload.segment_health.reused,
      error_segments: payload.segment_health.errors
    }
  };
}

export async function runTreasurySnapshot(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(LOCK_KEY, (client) => buildAndPublishReadModel({
    modelKey: TREASURY_SNAPSHOT_MODEL_KEY,
    schemaVersion: TREASURY_SNAPSHOT_SCHEMA_VERSION,
    ttlMs: options.ttlMs || TREASURY_SNAPSHOT_TTL_MS,
    client,
    now: options.now,
    build: () => buildTreasurySnapshotReadModel({ ...options, client })
  }));
}
