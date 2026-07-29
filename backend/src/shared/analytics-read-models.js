import { getRujiraBaseFeesDashboardPayload } from './rujira-base-fees.js';
import { getRujiraBaseLayerEarningsDashboardPayload } from './rujira-base-layer-earnings.js';
import { getRujiraReservePaymentsDashboardPayload } from './rujira-reserve-payments.js';
import { buildRapidSwapsSummaryPayload } from './rapid-swaps-dashboard.js';
import { buildTcFeeDashPayload } from './tc-fee-dash.js';
import { buildWasmArbEconomicsPayload } from './wasm-arb-economics.js';
import { ANALYTICS_READ_MODEL_KEYS } from './analytics-read-model-keys.js';
import { buildAndPublishReadModel } from './read-models.js';
import {
  getRecentlyBuiltReadModel,
  minimumIntervalResult,
  scheduledNow
} from './scheduled-read-model.js';

const RAPID_TTL_MS = 150_000;
const APP_LAYER_TTL_MS = 330_000;
const TC_FEE_TTL_MS = 900_000;
const WASM_ARB_ECONOMICS_TTL_MS = 330_000;

export async function refreshRapidSwapsReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.rapidSwaps;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 45_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: RAPID_TTL_MS,
    schemaVersion: 1,
    now,
    build: async (client) => {
      const payload = await buildRapidSwapsSummaryPayload(client, { now: now() });
      return {
        payload,
        generatedAt: payload.as_of,
        sourceUpdatedAt: payload.backend?.canonical_sync?.last_scanned_at || payload.backend?.last_run_at,
        stats: {
          swaps: payload.total_tracked,
          daily_buckets: payload.chart_buckets?.length || 0,
          payload_contract: payload.schema_version
        }
      };
    }
  });
}

export async function refreshAppLayerBaseFeesReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.appLayerBaseFees;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 240_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: APP_LAYER_TTL_MS,
    schemaVersion: 1,
    now,
    build: async (client) => {
      const payload = await getRujiraBaseFeesDashboardPayload(client);
      return {
        payload,
        generatedAt: now().toISOString(),
        sourceUpdatedAt: payload.meta?.updatedAt,
        stats: {
          events: payload.meta?.matchedSwapFeeEventCount || 0,
          daily_rows: payload.daily?.length || 0,
          weekly_rows: payload.weekly?.length || 0
        }
      };
    }
  });
}

export async function refreshAppLayerReservePaymentsReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.appLayerReservePayments;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 240_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: APP_LAYER_TTL_MS,
    schemaVersion: 1,
    now,
    build: async (client) => {
      const payload = await getRujiraReservePaymentsDashboardPayload(client, { eventLimit: 100 });
      return {
        payload,
        generatedAt: now().toISOString(),
        sourceUpdatedAt: payload.meta?.updatedAt,
        stats: {
          events: payload.meta?.eventCount || 0,
          returned_events: payload.events?.length || 0,
          daily_rows: payload.daily?.length || 0,
          weekly_rows: payload.weekly?.length || 0
        }
      };
    }
  });
}

export async function refreshAppLayerBaseLayerEarningsReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.appLayerBaseLayerEarnings;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 60_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: APP_LAYER_TTL_MS,
    schemaVersion: 1,
    now,
    build: async (client) => {
      const payload = await getRujiraBaseLayerEarningsDashboardPayload(client);
      return {
        payload,
        generatedAt: now().toISOString(),
        sourceUpdatedAt: payload.meta?.generatedAt,
        stats: {
          daily_rows: payload.daily?.length || 0,
          weekly_rows: payload.weekly?.length || 0,
          unpriced_denoms: payload.meta?.unpricedCoinCount || 0,
          source_stale: Boolean(payload.meta?.stale)
        }
      };
    }
  });
}

export async function refreshTcFeeDashReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.tcFeeDash;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 300_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: TC_FEE_TTL_MS,
    schemaVersion: 1,
    now,
    build: (client) => buildTcFeeDashPayload(client, { generatedAt: now().toISOString() })
  });
}

export async function refreshWasmArbEconomicsReadModel(options = {}) {
  const modelKey = ANALYTICS_READ_MODEL_KEYS.wasmArbEconomics;
  const existing = await getRecentlyBuiltReadModel(modelKey, options, 60_000);
  if (existing) return minimumIntervalResult(existing);
  const now = scheduledNow(options);
  return buildAndPublishReadModel({
    modelKey,
    client: options.client,
    ttlMs: WASM_ARB_ECONOMICS_TTL_MS,
    schemaVersion: 2,
    now,
    build: (client) => buildWasmArbEconomicsPayload(client, {
      generatedAt: now().toISOString()
    })
  });
}

// Keep this list limited to database-backed builders. Provider-backed models
// run in independent processes so a slow THORNode or market-history provider
// cannot hold the shared analytics advisory lock or delay these snapshots.
export const ANALYTICS_DATABASE_READ_MODEL_REFRESHERS = Object.freeze([
  ['rapidSwaps', refreshRapidSwapsReadModel],
  ['appLayerReservePayments', refreshAppLayerReservePaymentsReadModel],
  ['appLayerBaseLayerEarnings', refreshAppLayerBaseLayerEarningsReadModel],
  ['appLayerBaseFees', refreshAppLayerBaseFeesReadModel],
  ['tcFeeDash', refreshTcFeeDashReadModel],
  ['wasmArbEconomics', refreshWasmArbEconomicsReadModel]
]);

export async function refreshAnalyticsReadModels(options = {}) {
  // Keep the expensive App Layer scan sequential so it cannot consume the
  // entire connection pool alongside the compact models.
  const results = {};
  const refreshers = options.refreshers || ANALYTICS_DATABASE_READ_MODEL_REFRESHERS;
  for (const [name, refresh] of refreshers) {
    try {
      results[name] = await refresh(options);
    } catch (error) {
      results[name] = {
        ok: false,
        error: error?.message || String(error)
      };
    }
  }
  return results;
}
