import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  bankRuneSupplyBase,
  applyBurnTrackerLiveOverlay,
  incomeBurnBase,
  parseBurnTrackerInterval,
  resolveSystemIncomeBurnRate,
  runningBurnTotals
} from '../../shared/burn-tracker/model.js';
import { parseSystemIncomeBurnEvents } from '../src/shared/burn-tracker-blocks.js';
import {
  fetchBurnTrackerDailyHistory,
  ingestBurnTrackerHistory
} from '../src/shared/burn-tracker-ingestion.js';
import { buildBurnTrackerReadModel } from '../src/shared/burn-tracker.js';
import { runBurnTrackerBackfill, runBurnTrackerScheduler } from '../src/jobs/burn-tracker.js';

test('Burn Tracker selects only the Midgard income_burn lane and preserves base-unit precision', () => {
  const interval = {
    startTime: '1727308800',
    endTime: '1727395200',
    runePriceUSD: '4.125',
    pools: [
      { pool: 'BTC.BTC', earnings: '999999999' },
      { pool: 'income_burn', earnings: '15519567', rewards: '15519567' }
    ]
  };
  assert.equal(incomeBurnBase(interval), '15519567');
  assert.deepEqual(parseBurnTrackerInterval(interval), {
    day: '2024-09-26',
    burn_e8: '15519567',
    rune_price_usd: '4.125',
    interval_start: '2024-09-26T00:00:00.000Z',
    interval_end: '2024-09-27T00:00:00.000Z',
    partial: false,
    source: 'liquify-midgard-earnings',
    source_json: interval
  });
});

test('Burn Tracker honors a zero Mimir and falls back to the compiled constant only when unset', () => {
  assert.deepEqual(resolveSystemIncomeBurnRate(
    { SYSTEMINCOMEBURNRATEBPS: 0 },
    { int_64_values: { SystemIncomeBurnRateBps: 1 } }
  ), { bps: 0, percent: 0, source: 'mimir' });
  assert.deepEqual(resolveSystemIncomeBurnRate(
    {},
    { int_64_values: { SystemIncomeBurnRateBps: 1 } }
  ), { bps: 1, percent: 0.01, source: 'constant' });
  assert.deepEqual(resolveSystemIncomeBurnRate({ SYSTEMINCOMEBURNRATEBPS: 500 }, {}), {
    bps: 500,
    percent: 5,
    source: 'mimir'
  });
});

test('Burn Tracker keeps total supply and cumulative burns as integer strings', () => {
  assert.equal(bankRuneSupplyBase({
    amount: { denom: 'rune', amount: '35402165993252075' }
  }), '35402165993252075');
  assert.deepEqual(runningBurnTotals([
    { day: '2024-09-26', burn_e8: '9007199254740993' },
    { day: '2024-09-27', burn_e8: '7' }
  ]).map((row) => row.cumulative_burn_e8), [
    '9007199254740993',
    '9007199254741000'
  ]);
  assert.deepEqual(runningBurnTotals([
    { day: '2024-09-26', burn_e8: '1' },
    { day: '2024-09-27', burn_e8: null },
    { day: '2024-09-28', burn_e8: '2' }
  ]).map((row) => row.cumulative_burn_e8), ['1', null, null]);
});

test('Burn Tracker parses exact per-block rewards burns and overlays them without losing precision', () => {
  assert.equal(parseSystemIncomeBurnEvents([
    {
      type: 'rewards',
      attributes: [
        { key: 'bond_reward', value: '99' },
        { key: 'income_burn', value: '9007199254740993' }
      ]
    }
  ]), '9007199254740993');
  assert.equal(parseSystemIncomeBurnEvents([
    {
      type: Buffer.from('rewards').toString('base64'),
      attributes: [{
        key: Buffer.from('income_burn').toString('base64'),
        value: Buffer.from('7').toString('base64')
      }]
    }
  ]), '7');

  const payload = applyBurnTrackerLiveOverlay({
    as_of: '2026-08-23T12:00:00Z',
    summary: {
      total_burned_e8: '201000000000000',
      current_supply_e8: '35400000000000000'
    },
    daily: [{
      day: '2026-08-23',
      burn_e8: '100000000',
      cumulative_burn_e8: '201000000000000',
      partial: true
    }]
  }, {
    days: [{ day: '2026-08-23', burn_e8: '9007199254740993' }],
    through_height: 123,
    through_time: '2026-08-23T12:00:06Z'
  });
  assert.equal(payload.summary.total_burned_e8, '9208199254740993');
  assert.equal(payload.summary.current_supply_e8, '26392800745259007');
  assert.equal(payload.daily[0].burn_e8, '9007199354740993');
  assert.equal(payload.live.through_height, 123);
});

test('Burn Tracker parses paginated daily earnings without treating an absent route lane as missing coverage', async () => {
  const calls = [];
  const result = await fetchBurnTrackerDailyHistory({
    startDate: '2024-09-26',
    endDate: '2024-09-27',
    skipDelay: true,
    fetchMidgard: async (path) => {
      calls.push(path);
      return {
        intervals: [
          { startTime: '1727308800', endTime: '1727395200', runePriceUSD: '4', pools: [{ pool: 'income_burn', earnings: '10' }] },
          { startTime: '1727395200', endTime: '1727481600', runePriceUSD: '4.1', pools: [] }
        ],
        meta: {}
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /interval=day/);
  assert.deepEqual(result.rows.map((row) => [row.day, row.burn_e8]), [
    ['2024-09-26', '10'],
    ['2024-09-27', '0']
  ]);
});

test('Burn Tracker ingestion replaces the interval bucket with the live partial UTC day', async () => {
  let persisted = [];
  let syncState;
  const result = await ingestBurnTrackerHistory({ id: 'db' }, {
    now: new Date('2024-09-27T12:00:00Z'),
    getSyncState: async () => null,
    loadPendingDays: async () => ['2024-09-26'],
    loadTotals: async () => ({ complete: true, completed_burn_e8: '10', current_burn_e8: '7' }),
    fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 1, timestamp: 1727438400 } }),
    loadCoverage: async () => ({ first_day: null }),
    fetchDaily: async () => ({
      pages: 1,
      rows: [
        { day: '2024-09-26', burn_e8: '10', rune_price_usd: '4', partial: false,
          interval_start: '2024-09-26T00:00:00Z', interval_end: '2024-09-27T00:00:00Z', source_json: { pools: [] } },
        { day: '2024-09-27', burn_e8: '0', partial: false }
      ]
    }),
    fetchCurrent: async () => ({ day: '2024-09-27', burn_e8: '7', partial: true }),
    fetchAllTime: async () => ({ burn_e8: '17' }),
    upsert: async (_client, rows) => { persisted.push(...rows); return rows.length; },
    updateSyncState: async (_client, state) => { syncState = state; }
  });
  assert.equal(result.all_time_burn_e8, '17');
  assert.deepEqual(persisted.sort((a, b) => a.day.localeCompare(b.day)).map((row) => [row.day, row.burn_e8, row.partial]), [
    ['2024-09-26', '10', false],
    ['2024-09-27', '7', true]
  ]);
  assert.equal(syncState.lastCompletedDay, '2024-09-26');
});

test('Burn Tracker read model combines stored burns with existing core Mimir, constants, and supply', async () => {
  const result = await buildBurnTrackerReadModel({ id: 'db' }, {
    now: new Date('2024-09-28T12:00:00Z'),
    startDate: '2024-09-26',
    loadDays: async () => [
      { day: '2024-09-26', burn_e8: '10', rune_price_usd: '4', partial: false, source: 'midgard' },
      { day: '2024-09-27', burn_e8: '20', rune_price_usd: '4.2', partial: false, source: 'midgard' },
      { day: '2024-09-28', burn_e8: '5', rune_price_usd: '4.3', partial: true, source: 'midgard-live' }
    ],
    loadCoverage: async () => ({ observed_days: 3, source_updated_at: '2024-09-28T12:00:00Z' }),
    getSyncState: async () => ({
      last_completed_day: '2024-09-27',
      last_error: '',
      stats_json: { all_time_burn_e8: '35' },
      updated_at: '2024-09-28T12:00:00Z'
    }),
    getCoreSnapshot: async () => ({
      payload: {
        mimir: { SYSTEMINCOMEBURNRATEBPS: 500 },
        constants: { int_64_values: { SystemIncomeBurnRateBps: 1 } },
        rune_supply: { amount: { denom: 'rune', amount: '35402165993252075' } },
        source_updated_at: '2024-09-28T12:00:00Z'
      }
    })
  });
  assert.deepEqual(result.payload.summary, {
    total_burned_e8: '35',
    current_supply_e8: '35402165993252075',
    burn_rate_bps: 500,
    burn_rate_percent: 5
  });
  assert.deepEqual(result.payload.daily.map((row) => row.cumulative_burn_e8), ['10', '30', '35']);
  assert.deepEqual(result.payload.coverage.missing_days, []);
});

test('scheduled and manual Burn Tracker jobs share the isolated lock and publish the read model', async () => {
  const calls = [];
  const common = {
    now: new Date('2024-09-28T12:00:00Z'),
    lockRunner: async (key, callback) => {
      calls.push(['lock', key]);
      return callback({ id: 'db' });
    },
    ingest: async (_client, options) => {
      calls.push(['ingest', Boolean(options.full)]);
      return { rows: 1 };
    },
    publish: async (options) => {
      calls.push(['publish', options.modelKey]);
      await options.build();
      return { ok: true };
    },
    buildReadModel: async () => ({ payload: {} })
  };
  await runBurnTrackerScheduler(common);
  await runBurnTrackerBackfill(common);
  assert.deepEqual(calls, [
    ['lock', 'boonetools:system-income-burn'],
    ['ingest', false],
    ['publish', 'system-income-burn:v1'],
    ['lock', 'boonetools:system-income-burn'],
    ['ingest', true],
    ['publish', 'system-income-burn:v1']
  ]);
});

test('migrations, jobs, route, timer, and deploy encode the Burn Tracker production contract', async () => {
  const [migration, blockMigration, runJob, server, timer, service, backfill, deploy, smoke] = await Promise.all([
    readFile(new URL('../migrations/049_system_income_burn_tracker.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/050_system_income_burn_blocks.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-burn-tracker.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-burn-tracker.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-burn-tracker-backfill.service', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/perf-smoke.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /create table if not exists public\.system_income_burn_daily/);
  assert.match(blockMigration, /add column if not exists system_income_burn_e8/);
  assert.match(runJob, /'burn-tracker-backfill': runBurnTrackerBackfill/);
  assert.match(runJob, /'burn-tracker-scheduler': runBurnTrackerScheduler/);
  assert.match(server, /\['\/burn-tracker', route\(handleBurnTracker, 1, 64\)\]/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(service, /src\/run-job\.js burn-tracker-scheduler/);
  assert.match(backfill, /src\/run-job\.js burn-tracker-backfill/);
  assert.match(deploy, /boonetools-burn-tracker\.service/);
  assert.match(deploy, /--allow-stale-endpoint burn-tracker/);
  assert.match(smoke, /name: 'burn-tracker', path: '\/burn-tracker'/);
});
