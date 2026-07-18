import { getReadModel } from './read-models.js';

export function scheduledNow(options = {}) {
  if (typeof options.now === 'function') return options.now;
  if (options.now instanceof Date) return () => new Date(options.now.getTime());
  return () => new Date();
}

export async function getRecentlyBuiltReadModel(modelKey, options, minIntervalMs) {
  if (options.force === true) return null;
  const now = scheduledNow(options);
  const nowMs = now().getTime();
  const model = await getReadModel(modelKey, {
    client: options.client,
    nowMs
  });
  if (!model?.generatedAt) return null;
  const ageMs = nowMs - Date.parse(model.generatedAt);
  return ageMs >= 0 && ageMs < minIntervalMs ? model : null;
}

export function minimumIntervalResult(model) {
  return {
    ok: true,
    skipped: true,
    reason: 'minimum_refresh_interval',
    model
  };
}
