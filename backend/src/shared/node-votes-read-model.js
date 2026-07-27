import {
  buildNodeVotesSummaryPayload,
  loadCurrentNodeVoteChainState
} from '../handlers/node-votes.js';
import { ANALYTICS_READ_MODEL_KEYS } from './analytics-read-model-keys.js';
import { buildAndPublishReadModel, publishReadModel } from './read-models.js';
import {
  getRecentlyBuiltReadModel,
  minimumIntervalResult,
  scheduledNow
} from './scheduled-read-model.js';

export const NODE_VOTES_READ_MODEL_TTL_MS = 150_000;

export async function refreshNodeVotesReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.nodeVotes;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 45_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: NODE_VOTES_READ_MODEL_TTL_MS,
    schemaVersion: 1,
    now,
    build: async (client) => {
      let chainState = options.chainState || null;
      if (!chainState) {
        const loadChainState = options.loadNodeVoteChainState || loadCurrentNodeVoteChainState;
        const liveState = await loadChainState({ client });
        if (
          !liveState.currentNodeMimirsAvailable ||
          !Number.isFinite(Number(liveState.activeNodeCount)) ||
          Number(liveState.activeNodeCount) <= 0
        ) {
          throw new Error('THORNode returned an incomplete node-vote chain state');
        }
        chainState = { ...liveState, source: 'thornode-core-snapshot' };
        const observedAt = liveState.sourceUpdatedAt || now().toISOString();
        await publishReadModel(ANALYTICS_READ_MODEL_KEYS.nodeVotesChainState, chainState, {
          client,
          ttlMs: NODE_VOTES_READ_MODEL_TTL_MS,
          schemaVersion: 1,
          generatedAt: observedAt,
          sourceUpdatedAt: observedAt,
          metadata: { internal: true }
        });
      }
      if (!chainState?.currentNodeMimirsAvailable) {
        throw new Error('No complete node-vote chain state is available');
      }
      // Rejecting the build leaves the previously published summary untouched;
      // old chain state is never republished with a fresh timestamp.
      return buildNodeVotesSummaryPayload(client, {
        now: now(),
        chainState,
        allowProvider: false
      });
    }
  });
}
