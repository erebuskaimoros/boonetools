import { withAdvisoryLock } from '../db/lock.js';
import { refreshAnalyticsReadModels } from '../shared/analytics-read-models.js';

const LOCK_KEY = 'boonetools:analytics-read-models';

export async function runAnalyticsReadModels(options = {}) {
  const {
    lockRunner = withAdvisoryLock,
    refresh = refreshAnalyticsReadModels,
    ...refreshOptions
  } = options;
  const result = await lockRunner(LOCK_KEY, (client) => refresh({
    ...refreshOptions,
    client
  }));
  const failures = Object.entries(result || {})
    .filter(([, lane]) => lane?.ok === false)
    .map(([name, lane]) => `${name}: ${lane.error || 'refresh failed'}`);
  if (failures.length) {
    throw new Error(`Analytics read-model refresh failed (${failures.join('; ')})`);
  }
  return result;
}
