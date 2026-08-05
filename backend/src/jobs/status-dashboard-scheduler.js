import { withAdvisoryLock } from '../db/lock.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { buildAndPublishReadModel } from '../shared/read-models.js';
import { getReadModel } from '../shared/read-models.js';
import {
  STATUS_DASHBOARD_MODEL_KEY,
  STATUS_DASHBOARD_SCHEMA_VERSION,
  STATUS_DASHBOARD_TTL_MS,
  buildStatusDashboardReadModel
} from '../shared/status-dashboard.js';
import { getStatusLiveReadModel } from '../shared/status-live.js';
import { buildStuckTransactionSnapshot } from '../shared/stuck-transactions.js';
import { refreshBlockProductionHistory } from '../shared/block-production.js';

const LOCK_KEY = 'boonetools:status-dashboard';

async function loadLiveNetwork(client) {
  const model = await getStatusLiveReadModel({ client });
  if (!model) throw new Error('Live status read model is not available');
  return {
    ...model.payload,
    read_model: {
      stale: model.stale,
      generated_at: model.generatedAt,
      source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil
    }
  };
}

async function loadVoteDashboard() {
  const model = await getReadModel(ANALYTICS_READ_MODEL_KEYS.nodeVotes);
  if (!model) throw new Error('Node-vote read model is not available');
  return {
    ...model.payload,
    read_model: {
      stale: model.stale,
      generated_at: model.generatedAt,
      source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil
    }
  };
}

function latestSourceTimestamp(values) {
  const timestamps = values
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

export async function buildStatusDashboardSnapshot(options = {}) {
  const loadNetwork = options.loadLiveNetwork || (() => loadLiveNetwork(options.client));
  const loadVotes = options.loadVoteDashboard || loadVoteDashboard;
  const loadStuck = options.loadStuckDashboard || (() => buildStuckTransactionSnapshot(
    undefined,
    { client: options.client }
  ));
  const loadBlockProduction = options.loadBlockProductionHistory || (() => (
    options.client
      ? refreshBlockProductionHistory(options.client, options.blockProductionOptions)
      : Promise.resolve({ points: [], as_of: null, source: 'unavailable-in-test' })
  ));
  const [liveNetwork, voteDashboard, stuckDashboard, blockProduction] = await Promise.all([
    loadNetwork(),
    loadVotes(),
    loadStuck(),
    loadBlockProduction().catch((error) => ({
      points: [],
      as_of: null,
      source: 'liquify-thorchain-block-headers',
      warning: error?.message || 'Block-production history is unavailable'
    }))
  ]);
  if (liveNetwork?.stale || liveNetwork?.read_model?.stale) {
    throw new Error('Live status publisher did not produce a fresh network snapshot');
  }
  if (stuckDashboard?.stale) {
    throw new Error('Stuck-transaction providers did not produce a fresh status snapshot');
  }
  const generatedAt = options.generatedAt || new Date().toISOString();
  const payload = buildStatusDashboardReadModel({
    liveNetwork,
    voteDashboard,
    stuckDashboard,
    blockProduction,
    generatedAt
  });
  return {
    payload,
    generatedAt,
    sourceUpdatedAt: latestSourceTimestamp([
      liveNetwork.source?.as_of || liveNetwork.as_of,
      voteDashboard.as_of,
      stuckDashboard.scanned_at,
      blockProduction.as_of
    ]),
    metadata: {
      partial: payload.partial,
      warnings: payload.warnings,
      source_timestamps: payload.sources
    },
    stats: {
      chains: payload.chains.length,
      active_nodes: payload.network.active_node_count,
      governance_votes: payload.votes.governance.length,
      status_updates: payload.votes.status_updates.length,
      stuck_transactions: payload.stuck_transactions.transactions.length,
      block_production_points: payload.block_production.points.length,
      partial: payload.partial
    }
  };
}

export async function runStatusDashboardScheduler(options = {}) {
  const lockRunner = options.lockRunner || withAdvisoryLock;
  return lockRunner(LOCK_KEY, (client) => buildAndPublishReadModel({
    modelKey: STATUS_DASHBOARD_MODEL_KEY,
    schemaVersion: STATUS_DASHBOARD_SCHEMA_VERSION,
    ttlMs: options.ttlMs || STATUS_DASHBOARD_TTL_MS,
    client,
    now: options.now,
    build: () => buildStatusDashboardSnapshot({ ...options, client })
  }));
}
