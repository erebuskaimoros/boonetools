import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import { ingestPoolAnalysisHistory } from '../shared/pool-analysis-ingestion.js';
import {
  POOL_ANALYSIS_MODEL_KEY,
  POOL_ANALYSIS_SCHEMA_VERSION,
  POOL_ANALYSIS_TTL_MS,
  buildPoolAnalysisReadModel
} from '../shared/pool-analysis.js';

const LOCK_KEY = 'boonetools:pool-analysis';

async function ingestAndPublish(client, options = {}) {
  const ingestion = await (options.ingest || ingestPoolAnalysisHistory)(client, options);
  const published = await (options.publish || buildAndPublishReadModel)({
    modelKey: POOL_ANALYSIS_MODEL_KEY,
    schemaVersion: POOL_ANALYSIS_SCHEMA_VERSION,
    ttlMs: POOL_ANALYSIS_TTL_MS,
    client,
    now: typeof options.now === 'function' ? options.now : options.now ? () => new Date(options.now) : undefined,
    build: () => (options.buildReadModel || buildPoolAnalysisReadModel)(client, options)
  });
  return { ...ingestion, published: Boolean(published?.ok ?? true) };
}

export async function runPoolAnalysisScheduler(options = {}) {
  return (options.lockRunner || withAdvisoryLock)(
    LOCK_KEY,
    (client) => ingestAndPublish(client, options)
  );
}

export async function runPoolAnalysisBackfill(options = {}) {
  return (options.lockRunner || withAdvisoryLock)(
    LOCK_KEY,
    (client) => ingestAndPublish(client, { ...options, full: true })
  );
}
