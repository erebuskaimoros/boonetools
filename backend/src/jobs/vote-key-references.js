import { withAdvisoryLock } from '../db/lock.js';
import { getReadModel, publishReadModel } from '../shared/read-models.js';
import { createReferenceStore } from '../vote-references/catalog.js';
import { processReferences } from '../vote-references/worker.js';

export async function runVoteKeyReferences(options = {}) {
  if (process.env.VOTE_REFERENCE_ENABLED !== 'true' && !options.enabled) return { skipped: true, reason: 'disabled' };
  return (options.lockRunner || withAdvisoryLock)('boonetools:vote-key-references', async client => {
    const votes = await getReadModel('node-votes-summary:v1', { client });
    const core = await getReadModel('thornode-core:v1', { client });
    // The cached /version.current is the network's active version. A next or
    // locally installed version must never substitute for deployed behavior.
    const version = !core?.stale && ['fresh', 'cached'].includes(core?.payload?.field_meta?.version?.status)
      ? core.payload.version?.current : null;
    return processReferences({
      store: createReferenceStore(client), payload: votes?.payload, version,
      authDirectory: process.env.VOTE_REFERENCE_AUTH_DIR || '/var/lib/boonetools-vote-references/auth',
      sourceDirectory: process.env.VOTE_REFERENCE_SOURCE_DIR || '/var/lib/boonetools-vote-references/source',
      model: process.env.VOTE_REFERENCE_MODEL || 'gpt-6.1-sol',
      maxCalls: Math.min(100, Math.max(1, Number(process.env.VOTE_REFERENCE_MAX_CALLS_PER_DAY) || 20)),
      publish: references => publishReadModel('vote-key-references:v1', { references }, {
        client, ttlMs: 24 * 3600_000, schemaVersion: 1
      })
    });
  });
}
