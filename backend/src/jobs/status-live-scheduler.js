import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import {
  STATUS_LIVE_MODEL_KEY,
  STATUS_LIVE_SCHEMA_VERSION,
  STATUS_LIVE_TTL_MS,
  buildStatusNetworkReadModel
} from '../shared/status-live.js';
import { getNetworkSnapshot } from '../shared/network-snapshot.js';

const LOCK_KEY = 'boonetools:status-live';

function compactRunResult(result) {
  if (!result?.model) return result;
  const { model } = result;
  return {
    ok: result.ok,
    runId: result.runId,
    model: {
      key: model.key,
      schemaVersion: model.schemaVersion,
      generatedAt: model.generatedAt,
      sourceUpdatedAt: model.sourceUpdatedAt,
      freshUntil: model.freshUntil,
      publishedAt: model.publishedAt,
      stale: model.stale,
      ageSeconds: model.ageSeconds
    }
  };
}

export async function buildStatusLiveSnapshot(options = {}) {
  const loadNetwork = options.loadNetworkSnapshot || (() => getNetworkSnapshot({ forceRefresh: true }));
  const networkSnapshot = await loadNetwork();
  if (networkSnapshot?.stale) {
    throw new Error('Network providers did not produce a fresh live status snapshot');
  }
  const generatedAt = options.generatedAt || new Date().toISOString();
  const payload = buildStatusNetworkReadModel({ networkSnapshot, generatedAt });
  return {
    payload,
    generatedAt,
    sourceUpdatedAt: networkSnapshot.as_of || generatedAt,
    metadata: {
      partial: payload.partial,
      warnings: payload.warnings,
      source: payload.source
    },
    stats: {
      chains: payload.chains.length,
      active_nodes: payload.network.active_node_count,
      height: payload.network.height,
      partial: payload.partial
    }
  };
}

export async function runStatusLiveScheduler(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  const publish = options.publish || buildAndPublishReadModel;
  const result = await lockRunner(LOCK_KEY, (client) => publish({
    modelKey: STATUS_LIVE_MODEL_KEY,
    schemaVersion: STATUS_LIVE_SCHEMA_VERSION,
    ttlMs: options.ttlMs || STATUS_LIVE_TTL_MS,
    client,
    now: options.now,
    build: () => buildStatusLiveSnapshot({ ...options, client })
  }));
  return compactRunResult(result);
}
