import { withAdvisoryLock } from '../db/lock.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import {
  STATUS_LIVE_MODEL_KEY,
  STATUS_LIVE_SCHEMA_VERSION,
  STATUS_LIVE_TTL_MS,
  buildStatusNetworkReadModel
} from '../shared/status-live.js';
import { getNetworkSnapshot } from '../shared/network-snapshot.js';
import { loadLatestChainHead, notifyChainHead, upsertChainHeader } from '../shared/chain-headers.js';
import { fetchCurrentRpcHead } from '../shared/chain-head-probe.js';

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
  const loadNetwork = options.loadNetworkSnapshot || (() => getNetworkSnapshot({
    client: options.client,
    readModelCache: false
  }));
  const loadLatestBlock = options.loadLatestChainHead || (
    typeof options.client?.query === 'function'
      ? loadLatestChainHead
      : async () => null
  );
  const [networkSnapshot, storedBlock] = await Promise.all([
    loadNetwork(),
    loadLatestBlock(options.client)
  ]);
  const loadRpcHead = options.loadRpcHead || (
    typeof options.client?.query === 'function' ? fetchCurrentRpcHead : async () => null
  );
  let latestBlock = null;
  let probeWarning = '';
  try {
    latestBlock = await loadRpcHead({ client: options.client, minimumHeight: storedBlock?.height });
    if (latestBlock && latestBlock.height < (storedBlock?.height || 0)) {
      throw new Error('RPC chain head is behind the durable watermark');
    }
    // The REST fallback keeps SSE and the core snapshot's durable watermark
    // current during a broken/replaying WebSocket connection. Header upserts
    // preserve richer event-derived income, fees and swap flags already stored.
    const persistHead = options.persistHead || (async (client, head) => {
      const stored = await upsertChainHeader(client, { ...head, blockTime: head.time });
      if (stored) await notifyChainHead(client, stored);
    });
    if (latestBlock && (options.persistHead || typeof options.client?.query === 'function')) {
      await persistHead(options.client, latestBlock);
    }
  } catch {
    latestBlock = null;
    probeWarning = 'Current RPC chain head could not be verified; consensus status is unavailable.';
  }
  if (networkSnapshot?.stale) {
    throw new Error('Network providers did not produce a fresh live status snapshot');
  }
  const generatedAt = options.generatedAt || new Date().toISOString();
  const payload = buildStatusNetworkReadModel({
    networkSnapshot: probeWarning ? {
      ...networkSnapshot,
      partial: true,
      warnings: [...(networkSnapshot.warnings || []), probeWarning]
    } : networkSnapshot,
    generatedAt,
    latestBlock,
    stallThresholdMs: options.stallThresholdMs
  });
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
