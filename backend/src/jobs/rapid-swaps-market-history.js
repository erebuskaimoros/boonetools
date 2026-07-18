import { withAdvisoryLock } from '../db/lock.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { refreshRapidSwapMarketHistoryReadModel } from '../shared/rapid-swaps-market-history-read-model.js';
import { getReadModel } from '../shared/read-models.js';

export const RAPID_SWAPS_MARKET_HISTORY_LOCK_KEY = 'boonetools:rapid-swaps-market-history';
export const RAPID_SWAPS_MARKET_HISTORY_DUNE_TIMEOUT_MS = 3 * 60_000;
export const RAPID_SWAPS_MARKET_HISTORY_MIDGARD_TIMEOUT_MS = 45_000;

export async function runRapidSwapsMarketHistory(options = {}) {
  const {
    lockRunner = withAdvisoryLock,
    refresh = refreshRapidSwapMarketHistoryReadModel,
    readModel = getReadModel,
    ...refreshOptions
  } = options;
  return lockRunner(RAPID_SWAPS_MARKET_HISTORY_LOCK_KEY, async (client) => {
    try {
      return await refresh({
        marketHistoryDuneTimeoutMs: RAPID_SWAPS_MARKET_HISTORY_DUNE_TIMEOUT_MS,
        marketHistoryMidgardTimeoutMs: RAPID_SWAPS_MARKET_HISTORY_MIDGARD_TIMEOUT_MS,
        ...refreshOptions,
        client
      });
    } catch (error) {
      const previous = await readModel(ANALYTICS_READ_MODEL_KEYS.rapidSwapMarketHistory, {
        client,
        allowStale: true
      }).catch(() => null);
      const usable = ['hour', 'day'].every((key) => (
        Array.isArray(previous?.payload?.segments?.[key]?.intervals)
        && previous.payload.segments[key].intervals.length > 0
      ));
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
