import { buildStatusDashboardReadModel } from '../../../shared/status/model.js';
import { getReadModel } from './read-models.js';

export const STATUS_DASHBOARD_MODEL_KEY = 'status-dashboard:v1';
export const STATUS_DASHBOARD_SCHEMA_VERSION = 1;
// The timer runs every minute and the provider-backed build can legitimately
// span most of that interval. Preserve one missed-cycle of freshness headroom.
export const STATUS_DASHBOARD_TTL_MS = 150_000;

export async function getStatusDashboardReadModel(options = {}) {
  return getReadModel(STATUS_DASHBOARD_MODEL_KEY, {
    ...options,
    allowStale: options.allowStale !== false
  });
}

export { buildStatusDashboardReadModel };
