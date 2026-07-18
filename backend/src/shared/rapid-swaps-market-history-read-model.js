import { config } from '../lib/config.js';
import { ANALYTICS_READ_MODEL_KEYS } from './analytics-read-model-keys.js';
import { buildRapidSwapMarketHistoryPayload } from './rapid-swaps-market-history.js';
import { buildAndPublishReadModel, getReadModel } from './read-models.js';
import {
  getRecentlyBuiltReadModel,
  minimumIntervalResult,
  scheduledNow
} from './scheduled-read-model.js';

// Leave a complete timer interval of headroom so jitter and build time do not
// make a healthy model expire while its thirty-minute successor is being built.
export const RAPID_SWAP_MARKET_HISTORY_TTL_MS = 60 * 60_000;

function laterStartTime(...values) {
  const timestamps = values
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

export async function refreshRapidSwapMarketHistoryReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.rapidSwapMarketHistory;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 240_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  const previous = await getReadModel(modelKey, {
    client: options.client,
    allowStale: true
  });
  const trackerModel = await getReadModel(ANALYTICS_READ_MODEL_KEYS.rapidSwaps, {
    client: options.client,
    allowStale: true
  }).catch(() => null);
  const startTime = options.marketHistoryStartTime || laterStartTime(
    config.rapidSwapsDuneStartTime,
    trackerModel?.payload?.tracker_started_at
  );
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: RAPID_SWAP_MARKET_HISTORY_TTL_MS,
    schemaVersion: 1,
    now,
    build: async () => {
      const payload = await buildRapidSwapMarketHistoryPayload({
        now: now(),
        previous: previous?.payload,
        startTime,
        fetchDune: options.fetchMarketHistoryDune,
        fetchMidgard: options.fetchMarketHistoryMidgard,
        duneTimeoutMs: options.marketHistoryDuneTimeoutMs,
        midgardTimeoutMs: options.marketHistoryMidgardTimeoutMs
      });
      return {
        payload,
        generatedAt: payload.as_of,
        sourceUpdatedAt: payload.source_updated_at,
        stats: {
          hourly_rows: payload.segments?.hour?.intervals?.length || 0,
          daily_rows: payload.segments?.day?.intervals?.length || 0,
          stale_segments: Object.values(payload.segments || {})
            .filter((segment) => segment?.stale).length,
          warning: payload.warning || ''
        }
      };
    }
  });
}
