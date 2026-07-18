import { getReadModel } from './read-models.js';
import {
  TREASURY_SNAPSHOT_SCHEMA_VERSION,
  TREASURY_SNAPSHOT_TTL_MS,
  buildTreasurySnapshot
} from '../treasury/builder.js';

export const TREASURY_SNAPSHOT_MODEL_KEY = 'treasury-snapshot:v1';

export async function getTreasurySnapshotReadModel(options = {}) {
  return getReadModel(TREASURY_SNAPSHOT_MODEL_KEY, {
    ...options,
    allowStale: options.allowStale !== false
  });
}

export {
  buildTreasurySnapshot,
  TREASURY_SNAPSHOT_SCHEMA_VERSION,
  TREASURY_SNAPSHOT_TTL_MS
};
