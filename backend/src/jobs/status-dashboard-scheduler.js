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
import { getNetworkSnapshot } from '../shared/network-snapshot.js';
import { buildStuckTransactionSnapshot } from '../shared/stuck-transactions.js';

const LOCK_KEY = 'boonetools:status-dashboard';

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
  const loadNetwork = options.loadNetworkSnapshot || (() => getNetworkSnapshot({ forceRefresh: true }));
  const loadVotes = options.loadVoteDashboard || loadVoteDashboard;
  const loadStuck = options.loadStuckDashboard || buildStuckTransactionSnapshot;
  const [networkSnapshot, voteDashboard, stuckDashboard] = await Promise.all([
    loadNetwork(),
    loadVotes(),
    loadStuck()
  ]);
  if (networkSnapshot?.stale) {
    throw new Error('Network providers did not produce a fresh status snapshot');
  }
  if (stuckDashboard?.stale) {
    throw new Error('Stuck-transaction providers did not produce a fresh status snapshot');
  }
  const generatedAt = options.generatedAt || new Date().toISOString();
  const payload = buildStatusDashboardReadModel({
    networkSnapshot,
    voteDashboard,
    stuckDashboard,
    generatedAt
  });
  return {
    payload,
    generatedAt,
    sourceUpdatedAt: latestSourceTimestamp([
      networkSnapshot.as_of,
      voteDashboard.as_of,
      stuckDashboard.scanned_at
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
    build: () => buildStatusDashboardSnapshot(options)
  }));
}
