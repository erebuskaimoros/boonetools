import { withAdvisoryLock } from '../db/lock.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { refreshNodeVotesReadModel } from '../shared/node-votes-read-model.js';
import { getReadModel } from '../shared/read-models.js';

export const NODE_VOTES_SUMMARY_LOCK_KEY = 'boonetools:node-votes-summary';

export async function runNodeVotesSummary(options = {}) {
  const {
    lockRunner = withAdvisoryLock,
    refresh = refreshNodeVotesReadModel,
    readModel = getReadModel,
    ...refreshOptions
  } = options;
  return lockRunner(NODE_VOTES_SUMMARY_LOCK_KEY, async (client) => {
    try {
      return await refresh({ ...refreshOptions, client });
    } catch (error) {
      const previous = await readModel(ANALYTICS_READ_MODEL_KEYS.nodeVotes, {
        client,
        allowStale: true
      }).catch(() => null);
      const usable = previous?.payload?.chain_state?.complete === true
        && Array.isArray(previous?.payload?.by_vote)
        && Array.isArray(previous?.payload?.by_node);
      if (!usable) throw error;
      return {
        ok: true,
        skipped: true,
        stale: true,
        reason: 'preserved_last_good',
        error: error?.message || String(error),
        model: previous
      };
    }
  });
}
