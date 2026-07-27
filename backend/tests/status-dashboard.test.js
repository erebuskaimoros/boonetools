import assert from 'node:assert/strict';
import test from 'node:test';

import { handleStatusDashboard } from '../src/handlers/status-dashboard.js';
import { handleStatusLive } from '../src/handlers/status-live.js';
import { buildStatusDashboardSnapshot } from '../src/jobs/status-dashboard-scheduler.js';
import { buildStatusLiveSnapshot, runStatusLiveScheduler } from '../src/jobs/status-live-scheduler.js';
import { buildStatusDashboardReadModel, buildStatusNetworkReadModel } from '../../shared/status/model.js';

function sources() {
  return {
    networkSnapshot: {
      inbound_addresses: [
        { chain: 'BTC' },
        { chain: 'ETH', chain_trading_paused: true, chain_lp_actions_paused: true }
      ],
      nodes: [
        { status: 'Active', version: '3.8.0', status_since: 900 },
        { status: 'Active', version: '3.8.0', status_since: 901 },
        { status: 'Standby', version: '3.7.0', status_since: 800 }
      ],
      mimir: { HALTCHURNING: 0 },
      lastblock: [
        { chain: 'BTC', thorchain: 1000, last_observed_in: 50, last_signed_out: 49 },
        { chain: 'ETH', thorchain: 1000, last_observed_in: 60, last_signed_out: 58 }
      ],
      churns: [{ height: 900, date: 1_721_304_000_000_000_000 }],
      as_of: '2026-07-18T12:00:00Z',
      source: { live: 'thornode', churns: 'midgard' },
      partial: false,
      stale: false
    },
    voteDashboard: {
      as_of: '2026-07-18T12:00:01Z',
      stats: { latest_vote_at: '2026-07-18T11:55:00Z' },
      by_vote: [
        {
          mimir_key: 'MAXSYNTHPERPOOLDEPTH',
          mimir_category: 'economic',
          leader_value: '5000',
          leader_count: 64,
          consensus_threshold: 64,
          consensus_ready: true,
          latest_vote_at: '2026-07-18T11:55:00Z',
          latest_height: 999,
          effective_history: [{
            effective_value: '5000',
            block_time: '2026-07-18T11:55:00Z',
            height: 999,
            tx_id: 'DEF'
          }]
        },
        {
          mimir_key: 'HALTBTCTRADING',
          mimir_category: 'operational',
          effective_history: [{
            effective_value: '0',
            block_time: '2026-07-18T11:50:00Z',
            height: 995,
            tx_id: 'ABC'
          }]
        }
      ],
      backend: {
        backfill: { status: 'success' },
        ws_listener: { status: 'running' }
      }
    },
    stuckDashboard: {
      scanned_at: '2026-07-18T12:00:02Z',
      height: 1000,
      count: 1,
      transactions: [{
        tx_id: 'TX1',
        stage: 'outbound_signing',
        stage_label: 'Outbound signing',
        chain: 'BTC',
        asset: 'BTC.BTC',
        asset_ticker: 'BTC',
        amount: '100000000',
        destination: 'bc1destination',
        scheduled_height: 500,
        overdue_blocks: 500,
        completed_outbounds: 0,
        raw_provider_field_that_must_not_leak: 'large'
      }],
      partial: false,
      failed_lookups: 0
    },
    blockProduction: {
      window_hours: 24,
      live_interval_minutes: 5,
      as_of: '2026-07-18T12:00:00Z',
      source: 'thorchain-rpc-block-headers',
      points: [{
        time: '2026-07-18T12:00:00Z',
        height: 1000,
        seconds_per_block: 6.1254,
        block_count: 49,
        source: 'status-live'
      }]
    }
  };
}

test('status dashboard read model compacts network, governance, updates, and stuck rows', () => {
  const payload = buildStatusDashboardReadModel({
    ...sources(),
    generatedAt: '2026-07-18T12:00:03Z'
  });
  assert.equal(payload.network.height, 1000);
  assert.equal(payload.network.active_node_count, 2);
  assert.equal(payload.network.majority_version, '3.8.0');
  assert.equal(payload.network.summary.label, 'Degraded');
  assert.equal(payload.chains.length, 2);
  assert.equal(payload.block_production.points.length, 1);
  assert.equal(payload.block_production.points[0].seconds_per_block, 6.125);
  assert.equal(payload.votes.governance.length, 1);
  assert.equal(payload.votes.status_updates[0].description, 'MAXSYNTHPERPOOLDEPTH set to 5000');
  assert.equal(payload.votes.status_updates[1].description, 'BTC trading resumed');
  assert.equal(payload.stuck_transactions.count, 1);
  assert.equal(payload.stuck_transactions.transactions[0].raw_provider_field_that_must_not_leak, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 25_000);
});

test('status dashboard preserves the full 24-hour chart window within its payload budget', () => {
  const fixture = sources();
  const startMs = Date.parse('2026-07-17T12:00:00Z');
  fixture.blockProduction.points = Array.from({ length: 289 }, (_, index) => ({
    time: new Date(startMs + (index * 5 * 60_000)).toISOString(),
    height: 1_000 + (index * 50),
    seconds_per_block: 5.8 + ((index % 12) / 10),
    block_count: 50,
    source: 'status-live'
  }));
  fixture.blockProduction.as_of = fixture.blockProduction.points.at(-1).time;

  const payload = buildStatusDashboardReadModel({
    ...fixture,
    generatedAt: '2026-07-18T12:00:03Z'
  });

  assert.ok(payload.block_production.points.length <= 150);
  assert.equal(payload.block_production.points[0].time, '2026-07-17T12:00:00.000Z');
  assert.equal(payload.block_production.points.at(-1).time, '2026-07-18T12:00:00.000Z');
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 25_000);
});

test('status dashboard snapshot loads all source lanes concurrently into one payload', async () => {
  const fixture = sources();
  const snapshot = await buildStatusDashboardSnapshot({
    generatedAt: '2026-07-18T12:00:03Z',
    loadLiveNetwork: async () => buildStatusNetworkReadModel({
      networkSnapshot: fixture.networkSnapshot,
      generatedAt: '2026-07-18T12:00:03Z'
    }),
    loadVoteDashboard: async () => fixture.voteDashboard,
    loadStuckDashboard: async () => fixture.stuckDashboard,
    loadBlockProductionHistory: async () => fixture.blockProduction
  });
  assert.equal(snapshot.payload.votes.governance.length, 1);
  assert.equal(snapshot.payload.stuck_transactions.transactions.length, 1);
  assert.equal(snapshot.sourceUpdatedAt, '2026-07-18T12:00:02.000Z');
  assert.deepEqual(snapshot.stats, {
    chains: 2,
    active_nodes: 2,
    governance_votes: 1,
    status_updates: 2,
    stuck_transactions: 1,
    block_production_points: 1,
    partial: false
  });
});

test('status snapshot does not republish stale node votes as a fresh lane', async () => {
  const fixture = sources();
  fixture.voteDashboard.read_model = {
    stale: true,
    fresh_until: '2026-07-18T11:59:00Z'
  };
  const snapshot = await buildStatusDashboardSnapshot({
    generatedAt: '2026-07-18T12:00:03Z',
    loadLiveNetwork: async () => buildStatusNetworkReadModel({
      networkSnapshot: fixture.networkSnapshot,
      generatedAt: '2026-07-18T12:00:03Z'
    }),
    loadVoteDashboard: async () => fixture.voteDashboard,
    loadStuckDashboard: async () => fixture.stuckDashboard,
    loadBlockProductionHistory: async () => fixture.blockProduction
  });

  assert.equal(snapshot.payload.partial, true);
  assert.equal(snapshot.payload.stale, true);
  assert.equal(snapshot.payload.votes.source_status.stale, true);
  assert.match(snapshot.payload.warnings.join(' '), /node-vote read model is stale/i);
});

test('status public handler is DB-only, exposes stale state, and honors If-None-Match', async () => {
  const payload = buildStatusDashboardReadModel({
    ...sources(),
    generatedAt: '2026-07-18T12:00:03Z'
  });
  const model = {
    key: 'status-dashboard:v1',
    schemaVersion: 2,
    payload,
    etag: '"stored"',
    generatedAt: '2026-07-18T12:00:03.000Z',
    sourceUpdatedAt: '2026-07-18T12:00:02.000Z',
    freshUntil: '2026-07-18T12:01:18.000Z',
    publishedAt: '2026-07-18T12:00:04.000Z',
    stale: true
  };
  let reads = 0;
  const first = await handleStatusDashboard({ headers: {} }, null, {
    getReadModel: async () => { reads += 1; return model; }
  });
  assert.equal(reads, 1);
  assert.equal(first.status, 200);
  assert.equal(first.body.stale, true);
  assert.equal(first.headers['X-Boone-Read-Model-Stale'], '1');
  const conditional = await handleStatusDashboard({
    headers: { 'if-none-match': first.headers.ETag }
  }, null, {
    getReadModel: async () => model
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body, null);
});

test('status handler returns 503 without priming instead of contacting providers', async () => {
  const response = await handleStatusDashboard({ headers: {} }, null, {
    getReadModel: async () => null
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers['Retry-After'], '30');
});

test('live status snapshot excludes heavy dashboard lanes', async () => {
  const snapshot = await buildStatusLiveSnapshot({
    generatedAt: '2026-07-18T12:00:03Z',
    loadNetworkSnapshot: async () => sources().networkSnapshot
  });

  assert.equal(snapshot.payload.network.height, 1000);
  assert.equal(snapshot.payload.chains.length, 2);
  assert.equal(snapshot.payload.block_production, undefined);
  assert.equal(snapshot.payload.votes, undefined);
  assert.equal(snapshot.payload.stuck_transactions, undefined);
  assert.deepEqual(snapshot.stats, {
    chains: 2,
    active_nodes: 2,
    height: 1000,
    partial: false
  });
});

test('live status handler is DB-only and supports conditional polling', async () => {
  const snapshot = await buildStatusLiveSnapshot({
    generatedAt: '2026-07-18T12:00:03Z',
    loadNetworkSnapshot: async () => sources().networkSnapshot
  });
  const model = {
    key: 'status-live:v1',
    schemaVersion: 1,
    payload: snapshot.payload,
    etag: '"stored-live"',
    generatedAt: '2026-07-18T12:00:03.000Z',
    sourceUpdatedAt: '2026-07-18T12:00:00.000Z',
    freshUntil: '2026-07-18T12:00:48.000Z',
    publishedAt: '2026-07-18T12:00:04.000Z',
    stale: false,
    ageSeconds: 1
  };

  const first = await handleStatusLive({ headers: {} }, null, {
    getReadModel: async () => model
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.network.height, 1000);
  assert.match(first.headers['Cache-Control'], /max-age=5/);
  const conditional = await handleStatusLive({
    headers: { 'if-none-match': first.headers.ETag }
  }, null, {
    getReadModel: async () => model
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body, null);
});

test('live status scheduler publishes with a short TTL and logs a compact result', async () => {
  let publishOptions;
  const result = await runStatusLiveScheduler({
    lockRunner: async (key, callback) => {
      assert.equal(key, 'boonetools:status-live');
      return callback({ name: 'locked-client' });
    },
    loadNetworkSnapshot: async () => sources().networkSnapshot,
    publish: async (options) => {
      publishOptions = options;
      const built = await options.build();
      assert.equal(built.payload.network.height, 1000);
      return {
        ok: true,
        runId: '77',
        model: {
          key: options.modelKey,
          schemaVersion: options.schemaVersion,
          payload: built.payload,
          generatedAt: built.generatedAt,
          sourceUpdatedAt: built.sourceUpdatedAt,
          freshUntil: '2026-07-18T12:00:48.000Z',
          publishedAt: '2026-07-18T12:00:04.000Z',
          stale: false,
          ageSeconds: 0
        }
      };
    }
  });

  assert.equal(publishOptions.modelKey, 'status-live:v1');
  assert.equal(publishOptions.ttlMs, 45_000);
  assert.equal(result.model.key, 'status-live:v1');
  assert.equal(result.model.payload, undefined);
});
