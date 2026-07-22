import { buildStatusNetworkReadModel } from '../../../shared/status/model.js';
import { getReadModel } from './read-models.js';

export const STATUS_LIVE_MODEL_KEY = 'status-live:v1';
export const STATUS_LIVE_SCHEMA_VERSION = 1;
// The publisher runs every 15 seconds. Three missed cycles mark the lane stale.
export const STATUS_LIVE_TTL_MS = 45_000;

export async function getStatusLiveReadModel(options = {}) {
  return getReadModel(STATUS_LIVE_MODEL_KEY, {
    ...options,
    allowStale: options.allowStale !== false
  });
}

export { buildStatusNetworkReadModel };
