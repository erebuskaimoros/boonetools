import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildPolTrackerObservation,
  e8ToNumber
} from '../../shared/pol-tracker/model.js';
import { fetchHistoricalPolTrackerState } from '../src/pol-tracker/providers.js';
import { runPolTrackerBackfill, runPolTrackerScheduler } from '../src/jobs/pol-tracker.js';
import {
  buildPolTrackerPayload,
  lastCompletedUtcDay
} from '../src/shared/pol-tracker.js';
import {
  buildPolTrackerDays,
  loadPolTrackerBackfillPlan,
  polTrackerSampleTime,
  resolvePolTrackerAnchors,
  retryPolTrackerOperation
} from '../src/shared/pol-tracker-backfill.js';

const DAY_INPUT = {
  day: '2025-02-01',
  anchor: { height: 123, blockTime: '2025-02-01T23:59:57.000Z' },
  network: { rune_price_in_tor: '300000000' },
  pools: [{
    asset: 'BTC.BTC',
    status: 'Available',
    asset_tor_price: '200000000',
    balance_asset: '10000000000',
    balance_rune: '20000000000',
    pool_units: '100',
    LP_units: '75',
    synth_units: '25',
    synth_supply: '2000000000',
    savers_depth: '1000000000',
    savers_units: '9'
  }],
  treasuryLps: new Map([['BTC.BTC', {
    units: '10',
    asset_redeem_value: '400000000',
    rune_redeem_value: '300000000'
  }]]),
  treasuryErrors: [],
  runepool: {
    pol: { value: '10000000000' },
    reserve: { value: '6000000000' },
    providers: { value: '4000000000' }
  }
};

test('same-height formulas preserve the requested accounting lanes without Savers', () => {
  const observation = buildPolTrackerObservation(DAY_INPUT);
  assert.equal(e8ToNumber(observation.daily.synth_backing_usd_e8), 100);
  assert.equal(e8ToNumber(observation.daily.synth_face_usd_e8), 40);
  assert.equal(e8ToNumber(observation.daily.treasury_asset_usd_e8), 8);
  assert.equal(e8ToNumber(observation.daily.treasury_rune_usd_e8), 9);
  assert.equal(e8ToNumber(observation.daily.treasury_total_usd_e8), 17);
  assert.equal(e8ToNumber(observation.daily.reserve_pol_usd_e8), 300);
  assert.equal(e8ToNumber(observation.daily.runepool_provider_owned_rune_e8), 40);
  assert.equal(Object.hasOwn(observation.daily, 'runepool_reserve_owned_rune_e8'), false);
  assert.equal(Object.hasOwn(observation.daily, 'runepool_reserve_owned_usd_e8'), false);
  assert.equal(Object.hasOwn(observation.daily, 'savers_usd_e8'), false);
  assert.equal(Object.hasOwn(observation.daily.lane_status, 'savers'), false);
  assert.equal(Object.hasOwn(observation.daily.lane_status, 'runepool_reserve'), false);
  assert.equal(Object.hasOwn(observation.pools[0], 'savers_depth_e8'), false);
  assert.equal(Object.hasOwn(observation.pools[0], 'savers_units'), false);
  assert.equal(Object.hasOwn(observation.pools[0], 'savers_usd_e8'), false);
  assert.equal(observation.daily.complete, true);
});

test('public payload strips legacy Savers and all RUNEPool ownership values', () => {
  const observation = buildPolTrackerObservation(DAY_INPUT);
  const legacyDaily = {
    ...observation.daily,
    savers_usd_e8: '2000000000',
    runepool_reserve_owned_rune_e8: '6000000000',
    runepool_reserve_owned_usd_e8: '18000000000',
    complete: false,
    lane_status: {
      savers: { status: 'partial', warning: 'Legacy Saver warning' },
      ...observation.daily.lane_status,
      runepool_reserve: { status: 'complete', warning: '' }
    },
    warnings: ['Legacy Saver warning']
  };
  const legacyPools = observation.pools.map((pool) => ({
    ...pool,
    savers_depth_e8: '1000000000',
    savers_units: '9',
    savers_usd_e8: '2000000000'
  }));
  const payload = buildPolTrackerPayload([legacyDaily], legacyPools, {
    startDate: '2025-02-01',
    endDate: '2025-02-02',
    now: new Date('2025-02-03T00:10:00Z')
  });
  assert.equal(Object.hasOwn(payload.daily[0], 'runepool'), false);
  assert.equal(Object.hasOwn(payload.daily[0], 'savers_usd'), false);
  assert.equal(Object.hasOwn(payload.daily[0].status, 'savers'), false);
  assert.equal(Object.hasOwn(payload.daily[0].status, 'runepool_reserve'), false);
  assert.deepEqual(payload.daily[0].treasury_lp, { total_usd: 17 });
  assert.equal(Object.hasOwn(payload.daily[0].treasury_lp, 'asset_leg_usd'), false);
  assert.equal(Object.hasOwn(payload.daily[0].treasury_lp, 'rune_leg_usd'), false);
  assert.equal(Object.hasOwn(payload.latest_pools[0], 'savers_depth'), false);
  assert.equal(Object.hasOwn(payload.latest_pools[0], 'savers_usd'), false);
  assert.equal(Object.hasOwn(payload.latest_pools[0], 'treasury_asset_redeem'), false);
  assert.equal(Object.hasOwn(payload.latest_pools[0], 'treasury_rune_redeem'), false);
  assert.equal(Object.hasOwn(payload.latest_pools[0], 'treasury_asset_usd'), false);
  assert.equal(Object.hasOwn(payload.latest_pools[0], 'treasury_rune_usd'), false);
  assert.equal(Object.hasOwn(payload.methodology, 'savers'), false);
  assert.equal(Object.hasOwn(payload.methodology, 'runepool'), false);
  assert.equal(payload.daily[0].complete, true);
  assert.equal(payload.daily[0].warnings.includes('Legacy Saver warning'), false);
  assert.equal(payload.warnings.includes('Legacy Saver warning'), false);
  assert.equal(payload.daily[1].status.state, 'missing');
  assert.equal(Object.hasOwn(payload.daily[1], 'runepool'), false);
  assert.equal(payload.coverage.observed_days, 1);
  assert.equal(payload.coverage.missing_days, 1);
});

test('Treasury lookup failures create null Treasury totals without corrupting other lanes', () => {
  const observation = buildPolTrackerObservation({
    ...DAY_INPUT,
    treasuryErrors: [{ asset: 'BTC.BTC', error: 'timeout' }]
  });
  assert.equal(observation.daily.treasury_total_usd_e8, null);
  assert.equal(e8ToNumber(observation.daily.synth_backing_usd_e8), 100);
  assert.equal(observation.daily.lane_status.treasury.status, 'partial');
  assert.equal(observation.daily.complete, false);
});

test('a missing Treasury asset price preserves the independently redeemable RUNE leg', () => {
  const observation = buildPolTrackerObservation({
    ...DAY_INPUT,
    pools: [{ ...DAY_INPUT.pools[0], asset_tor_price: '0', savers_depth: '0', synth_units: '0' }]
  });
  assert.equal(observation.daily.treasury_asset_usd_e8, null);
  assert.equal(e8ToNumber(observation.daily.treasury_rune_usd_e8), 9);
  assert.equal(observation.daily.treasury_total_usd_e8, null);
  assert.match(observation.daily.lane_status.treasury.warning, /positions lacked/);
});

test('historical provider requests pin every source and LP query to one height', async () => {
  const paths = [];
  const state = await fetchHistoricalPolTrackerState(456, {
    requestDelayMs: 0,
    fetchHistorical: async (path) => {
      paths.push(path);
      if (path.startsWith('/thorchain/network')) return { rune_price_in_tor: '300000000' };
      if (path.startsWith('/thorchain/pools')) return [{ asset: 'BTC.BTC' }, { asset: 'ETH.ETH' }];
      if (path.startsWith('/thorchain/runepool')) {
        return { pol: { value: '1' }, providers: { value: '0' } };
      }
      return { units: '0', asset_redeem_value: '0', rune_redeem_value: '0' };
    }
  });
  assert.equal(paths.length, 5);
  assert.ok(paths.every((path) => path.endsWith('?height=456')));
  assert.equal(state.treasuryLps.size, 2);
  assert.equal(state.runepoolError, '');
});

test('daily planning uses completed UTC day-end points and resumes missing or partial rows', async () => {
  assert.deepEqual(buildPolTrackerDays('2025-02-01', '2025-02-03'), [
    '2025-02-01', '2025-02-02', '2025-02-03'
  ]);
  assert.equal(polTrackerSampleTime('2025-02-01'), '2025-02-01T23:59:59.999Z');
  assert.equal(lastCompletedUtcDay(new Date('2025-02-03T18:00:00Z')), '2025-02-02');

  const plan = await loadPolTrackerBackfillPlan({}, {
    startDate: '2025-02-01',
    endDate: '2025-02-03',
    loadExistingDays: async () => [
      { day: '2025-02-01', complete: true },
      { day: '2025-02-02', complete: false }
    ]
  });
  assert.deepEqual(plan.pendingDays, ['2025-02-02', '2025-02-03']);
});

test('anchor resolution retains the day paired with the finalized historical block', async () => {
  const anchors = await resolvePolTrackerAnchors(['2025-02-01'], {
    resolveAnchors: async (points) => [{
      observedAt: points[0],
      height: 789,
      blockTime: '2025-02-01T23:59:58.000Z'
    }]
  });
  assert.deepEqual(anchors[0], {
    day: '2025-02-01',
    height: 789,
    blockTime: '2025-02-01T23:59:58.000Z',
    sampleTime: '2025-02-01T23:59:59.999Z'
  });
});

test('POL Tracker retries transient history failures', async () => {
  let attempts = 0;
  const delays = [];
  const value = await retryPolTrackerOperation(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('fetch failed');
    return 'ok';
  }, {
    attempts: 3,
    baseDelayMs: 5,
    maxDelayMs: 20,
    sleep: async (delay) => delays.push(delay)
  });
  assert.equal(value, 'ok');
  assert.deepEqual(delays, [5, 10]);
});

test('migration, jobs, route, timer, and deployment encode the POL Tracker production contract', async () => {
  const [migration, runJob, server, timer, service, backfill, deploy] = await Promise.all([
    readFile(new URL('../migrations/046_pol_tracker.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pol-tracker.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pol-tracker.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-pol-tracker-backfill.service', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /create table if not exists public\.pol_tracker_daily/);
  assert.match(migration, /runepool_provider_owned_rune_e8/);
  assert.match(migration, /Never publish this provider-owned RUNEPool value/);
  assert.match(runJob, /'pol-tracker-backfill': runPolTrackerBackfill/);
  assert.match(runJob, /'pol-tracker-scheduler': runPolTrackerScheduler/);
  assert.match(server, /\['\/pol-tracker', route\(handlePolTracker, 1, 64\)\]/);
  assert.match(timer, /OnCalendar=\*-\*-\* 00:10:00 UTC/);
  assert.match(service, /src\/run-job\.js pol-tracker-scheduler/);
  assert.match(backfill, /src\/run-job\.js pol-tracker-backfill/);
  assert.match(backfill, /TimeoutStartSec=infinity/);
  assert.match(deploy, /boonetools-pol-tracker\.service/);
});

test('scheduled and manual POL jobs lag archive ingestion by one completed UTC day', async () => {
  const calls = [];
  const client = { id: 'db' };
  const common = {
    now: new Date('2026-08-19T12:00:00Z'),
    headLagDays: 1,
    lockRunner: async (key, callback) => {
      calls.push({ type: 'lock', key });
      return callback(client);
    },
    ingest: async (receivedClient, options) => {
      assert.equal(receivedClient, client);
      calls.push({ type: 'ingest', startDate: options.startDate, endDate: options.endDate });
      return { processed_days: 1 };
    },
    publish: async (options) => {
      calls.push({ type: 'publish', key: options.modelKey });
      return { ok: true };
    }
  };

  const scheduled = await runPolTrackerScheduler(common);
  assert.equal(scheduled.published, true);
  assert.deepEqual(calls.slice(0, 3), [
    { type: 'lock', key: 'boonetools:pol-tracker' },
    { type: 'ingest', startDate: '2026-08-11', endDate: '2026-08-17' },
    { type: 'publish', key: 'pol-tracker:v2' }
  ]);

  calls.length = 0;
  await runPolTrackerBackfill(common);
  assert.deepEqual(calls[1], {
    type: 'ingest',
    startDate: '2025-02-01',
    endDate: '2026-08-17'
  });
});
