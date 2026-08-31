import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildPolTrackerObservation,
  e8ToNumber,
  POL_TRACKER_RESERVE_MODULE,
  POL_TRACKER_TREASURY_MODULE
} from '../../shared/pol-tracker/model.js';
import { fetchHistoricalPolTrackerState } from '../src/pol-tracker/providers.js';
import { runPolTrackerBackfill, runPolTrackerScheduler } from '../src/jobs/pol-tracker.js';
import {
  buildPolTrackerPayload,
  lastCompletedUtcDay
} from '../src/shared/pol-tracker.js';
import {
  buildPolTrackerDays,
  ingestPolTrackerHistory,
  isPolTrackerHistoricalHeightUnavailable,
  isTransientPolTrackerError,
  loadPolTrackerBackfillPlan,
  polTrackerSampleTime,
  resolvePolTrackerAnchors,
  retryPolTrackerOperation
} from '../src/shared/pol-tracker-backfill.js';
import { loadPolTrackerExistingDays } from '../src/shared/pol-tracker-store.js';

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
  reserveLps: new Map([['BTC.BTC', {
    units: '25',
    asset_redeem_value: '2500000000',
    rune_redeem_value: '5000000000'
  }]]),
  reserveErrors: [],
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
  assert.equal(observation.daily.reserve_module_address, POL_TRACKER_RESERVE_MODULE);
  assert.equal(observation.daily.reserve_pool_count, 1);
  assert.equal(observation.pools[0].reserve_pol_lp_units, '25');
  assert.equal(e8ToNumber(observation.pools[0].reserve_pol_rune_e8), 100);
  assert.equal(e8ToNumber(observation.pools[0].reserve_pol_usd_e8), 300);
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
  assert.equal(payload.latest_pools[0].reserve_pol_rune, 100);
  assert.equal(payload.latest_pools[0].reserve_pol_usd, 300);
  assert.equal(Object.hasOwn(payload.methodology, 'savers'), false);
  assert.equal(Object.hasOwn(payload.methodology, 'runepool'), false);
  assert.equal(Object.keys(payload.methodology).some((key) => key.includes('runepool')), false);
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

test('Reserve lookup failures keep the aggregate value but mark its per-pool breakdown partial', () => {
  const observation = buildPolTrackerObservation({
    ...DAY_INPUT,
    reserveErrors: [{ asset: 'BTC.BTC', error: 'timeout' }]
  });
  assert.equal(e8ToNumber(observation.daily.reserve_pol_usd_e8), 300);
  assert.equal(observation.pools[0].reserve_pol_rune_e8, null);
  assert.equal(observation.pools[0].reserve_pol_usd_e8, null);
  assert.equal(observation.daily.lane_status.reserve_pol.status, 'partial');
  assert.match(observation.daily.lane_status.reserve_pol.warning, /Reserve POL LP lookup/);
  assert.equal(observation.daily.complete, false);
});

test('per-pool Reserve POL must reconcile exactly to runepool.pol.value', () => {
  const observation = buildPolTrackerObservation({
    ...DAY_INPUT,
    runepool: {
      ...DAY_INPUT.runepool,
      pol: { value: '9999999999' }
    }
  });
  assert.equal(observation.daily.lane_status.reserve_pol.status, 'partial');
  assert.match(observation.daily.lane_status.reserve_pol.warning, /did not reconcile/);
  assert.equal(observation.daily.complete, false);
});

test('per-pool Reserve POL mirrors THORNode safe-share rounding instead of LP-query truncation', () => {
  const observation = buildPolTrackerObservation({
    ...DAY_INPUT,
    pools: [{
      ...DAY_INPUT.pools[0],
      balance_rune: '5',
      pool_units: '3',
      LP_units: '2',
      synth_units: '1',
      synth_supply: '0'
    }],
    reserveLps: new Map([['BTC.BTC', {
      units: '1',
      asset_redeem_value: '0',
      // The LP response truncates 5 / 3 to one, while GetSafeShare rounds to two.
      rune_redeem_value: '1'
    }]]),
    runepool: {
      ...DAY_INPUT.runepool,
      pol: { value: '4' }
    }
  });
  assert.equal(observation.pools[0].reserve_pol_rune_e8, '4');
  assert.equal(observation.daily.lane_status.reserve_pol.status, 'complete');
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
  assert.equal(paths.length, 7);
  assert.ok(paths.every((path) => path.endsWith('?height=456')));
  assert.equal(paths.filter((path) => path.includes(POL_TRACKER_TREASURY_MODULE)).length, 2);
  assert.equal(paths.filter((path) => path.includes(POL_TRACKER_RESERVE_MODULE)).length, 2);
  assert.equal(state.treasuryLps.size, 2);
  assert.equal(state.reserveLps.size, 2);
  assert.deepEqual(state.reserveErrors, []);
  assert.equal(state.runepoolError, '');
});

test('legacy rows without a per-pool Reserve POL value remain eligible for backfill', async () => {
  let query = '';
  const rows = await loadPolTrackerExistingDays({
    query: async (text) => {
      query = text;
      return { rows: [{ day: '2025-02-01', complete: false }] };
    }
  }, '2025-02-01', '2025-02-01');
  assert.equal(rows[0].complete, false);
  assert.match(query, /reserve_module_address is not null/i);
  assert.match(query, /reserve_pol_rune_e8 is null/i);
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

test('POL Tracker skips completed days outside RPC history without shifting later anchors', async () => {
  const earliestMs = Date.parse('2026-08-19T00:00:00Z');
  const latestMs = Date.parse('2026-08-20T12:00:00Z');
  const anchors = await resolvePolTrackerAnchors(['2026-08-18', '2026-08-19'], {
    requestDelayMs: 0,
    fetchStatus: async () => ({
      earliestHeight: 100,
      earliestBlockTime: new Date(earliestMs).toISOString(),
      latestHeight: 200,
      latestBlockTime: new Date(latestMs).toISOString()
    }),
    fetchBlock: async (height) => ({
      height,
      blockTime: new Date(earliestMs + ((height - 100) * ((latestMs - earliestMs) / 100))).toISOString()
    })
  });

  assert.deepEqual(anchors.map(({ day }) => day), ['2026-08-19']);
  assert.equal(anchors[0].sampleTime, '2026-08-19T23:59:59.999Z');
});

test('POL Tracker resolves each day from an RPC whose retained range covers it', async () => {
  const ranges = {
    archive: {
      earliestHeight: 100,
      earliestBlockTime: '2024-09-04T19:40:00.000Z',
      latestHeight: 200,
      latestBlockTime: '2026-08-18T16:18:21.000Z'
    },
    live: {
      earliestHeight: 300,
      earliestBlockTime: '2026-08-19T04:03:18.000Z',
      latestHeight: 400,
      latestBlockTime: '2026-08-20T18:00:37.000Z'
    }
  };
  const providerKey = (options) => options.rpcUrls[0];
  const anchors = await resolvePolTrackerAnchors(['2026-08-18', '2026-08-19'], {
    rpcUrls: ['archive', 'live'],
    requestDelayMs: 0,
    fetchStatus: async (options) => ranges[providerKey(options)],
    fetchBlock: async (height, options) => {
      const range = ranges[providerKey(options)];
      const ratio = (height - range.earliestHeight) / (range.latestHeight - range.earliestHeight);
      return {
        height,
        blockTime: new Date(
          Date.parse(range.earliestBlockTime)
            + (ratio * (Date.parse(range.latestBlockTime) - Date.parse(range.earliestBlockTime)))
        ).toISOString()
      };
    }
  });

  assert.deepEqual(anchors.map(({ day }) => day), ['2026-08-19']);
  assert.equal(anchors[0].sampleTime, '2026-08-19T23:59:59.999Z');
});

test('POL Tracker leaves a THORNode history range gap missing and continues later days', async () => {
  const persistedDays = [];
  const progress = [];
  const anchors = [
    {
      day: '2026-08-18',
      height: 27_485_682,
      blockTime: '2026-08-18T23:59:58.000Z',
      sampleTime: '2026-08-18T23:59:59.999Z'
    },
    {
      day: '2026-08-19',
      height: 27_499_999,
      blockTime: '2026-08-19T23:59:58.000Z',
      sampleTime: '2026-08-19T23:59:59.999Z'
    }
  ];

  const result = await ingestPolTrackerHistory({}, {
    attempts: 1,
    anchorBatchDays: 2,
    loadPlan: async () => ({
      startDate: '2026-08-18',
      endDate: '2026-08-19',
      allDays: ['2026-08-18', '2026-08-19'],
      lastStoredDay: null,
      pendingDays: ['2026-08-18', '2026-08-19']
    }),
    resolveBatchAnchors: async () => anchors,
    collectDay: async (anchor) => {
      if (anchor.day === '2026-08-18') {
        const error = new Error(
          'Provider service:thornode.thorchain.liquify.com:pol-tracker-history is cooling down: '
          + 'Request failed (500): invalid height: cannot query with height in the future'
        );
        error.name = 'ProviderCooldownError';
        throw error;
      }
      return buildPolTrackerObservation({
        ...DAY_INPUT,
        day: anchor.day,
        anchor
      });
    },
    persist: async (_client, observation) => persistedDays.push(observation.daily.day),
    updateSync: async () => {},
    logProgress: (event) => progress.push(event)
  });

  assert.deepEqual(persistedDays, ['2026-08-19']);
  assert.equal(result.processed_days, 1);
  assert.equal(result.unavailable_days, 1);
  assert.equal(result.last_completed_day, '2026-08-19');
  assert.equal(result.target_end_day_complete, true);
  assert.deepEqual(progress[0], {
    day: '2026-08-18',
    height: 27_485_682,
    processed: 0,
    pending: 2,
    complete: false,
    unavailable: true
  });
});

test('POL Tracker marks anchor-resolution gaps unavailable and exposes an incomplete target day', async () => {
  const progress = [];
  const sync = [];
  const result = await ingestPolTrackerHistory({}, {
    attempts: 1,
    anchorBatchDays: 2,
    loadPlan: async () => ({
      startDate: '2026-08-18',
      endDate: '2026-08-19',
      allDays: ['2026-08-18', '2026-08-19'],
      lastStoredDay: '2026-08-18',
      pendingDays: ['2026-08-19']
    }),
    resolveBatchAnchors: async () => [],
    collectDay: async () => assert.fail('an unresolved anchor must not be collected'),
    persist: async () => assert.fail('an unresolved anchor must not be persisted'),
    updateSync: async (_client, state) => sync.push(state),
    logProgress: (event) => progress.push(event)
  });

  assert.equal(result.processed_days, 0);
  assert.equal(result.unavailable_days, 1);
  assert.equal(result.last_completed_day, '2026-08-18');
  assert.equal(result.target_end_day_complete, false);
  assert.match(sync.at(-1).lastError, /No configured RPC provider resolved/);
  assert.deepEqual(progress, [{
    day: '2026-08-19',
    height: null,
    processed: 0,
    pending: 1,
    complete: false,
    unavailable: true
  }]);
});

test('POL Tracker keeps generic provider failures retryable while isolating the exact history gap', () => {
  const genericServerError = Object.assign(new Error('upstream service failed'), { status: 500 });
  const genericCooldown = new Error('Provider service:archive is cooling down');
  genericCooldown.name = 'ProviderCooldownError';
  const historicalGapCooldown = new Error(
    'Provider service:archive is cooling down: invalid height: cannot query with height in the future'
  );
  historicalGapCooldown.name = 'ProviderCooldownError';

  assert.equal(isTransientPolTrackerError(genericServerError), true);
  assert.equal(isTransientPolTrackerError(genericCooldown), true);
  assert.equal(isPolTrackerHistoricalHeightUnavailable(historicalGapCooldown), true);
  assert.equal(isTransientPolTrackerError(historicalGapCooldown), false);
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
  const [migration, poolBreakdownMigration, runJob, server, timer, service, backfill, deploy] = await Promise.all([
    readFile(new URL('../migrations/046_pol_tracker.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/047_pol_tracker_pool_breakdown.sql', import.meta.url), 'utf8'),
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
  assert.match(poolBreakdownMigration, /reserve_module_address/);
  assert.match(poolBreakdownMigration, /reserve_pol_lp_units/);
  assert.match(poolBreakdownMigration, /reserve_pol_rune_e8/);
  assert.match(poolBreakdownMigration, /reserve_pol_usd_e8/);
  assert.match(runJob, /'pol-tracker-backfill': runPolTrackerBackfill/);
  assert.match(runJob, /'pol-tracker-scheduler': runPolTrackerScheduler/);
  assert.match(server, /\['\/pol-tvl', route\(handlePolTracker, 1, 64\)\]/);
  assert.match(timer, /OnCalendar=\*-\*-\* 00:10:00 UTC/);
  assert.match(service, /src\/run-job\.js pol-tracker-scheduler/);
  assert.match(service, /Restart=on-failure/);
  assert.match(service, /RestartSec=15m/);
  assert.match(backfill, /src\/run-job\.js pol-tracker-backfill/);
  assert.match(backfill, /TimeoutStartSec=infinity/);
  assert.match(deploy, /boonetools-pol-tracker\.service/);
});

test('scheduled POL job publishes before failing an incomplete current target for retry', async () => {
  const calls = [];
  await assert.rejects(runPolTrackerScheduler({
    now: new Date('2026-08-21T12:00:00Z'),
    headLagDays: 1,
    lockRunner: async (_key, callback) => callback({ id: 'db' }),
    ingest: async () => {
      calls.push('ingest');
      return { target_end_day_complete: false };
    },
    publish: async (options) => {
      calls.push('publish');
      await options.build();
      return { ok: true };
    },
    buildReadModel: async () => {
      calls.push('build');
      return { payload: {} };
    }
  }), /target end day 2026-08-19 remains incomplete/);

  assert.deepEqual(calls, ['ingest', 'publish', 'build']);
});

test('scheduled POL job targets the latest completed UTC day by default', async () => {
  const calls = [];
  await runPolTrackerScheduler({
    now: new Date('2026-08-23T21:00:00Z'),
    lockRunner: async (_key, callback) => callback({ id: 'db' }),
    ingest: async (_client, options) => {
      calls.push({ type: 'ingest', startDate: options.startDate, endDate: options.endDate });
      return { target_end_day_complete: true };
    },
    publish: async (options) => {
      await options.build();
      return { ok: true };
    },
    buildReadModel: async (_client, options) => {
      calls.push({ type: 'build', startDate: options.startDate, endDate: options.endDate });
      return { payload: {} };
    }
  });

  assert.deepEqual(calls, [
    { type: 'ingest', startDate: '2026-08-16', endDate: '2026-08-22' },
    { type: 'build', startDate: '2025-02-01', endDate: '2026-08-22' }
  ]);
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
      await options.build();
      calls.push({ type: 'publish', key: options.modelKey });
      return { ok: true };
    },
    buildReadModel: async (receivedClient, options) => {
      assert.equal(receivedClient, client);
      calls.push({ type: 'build', startDate: options.startDate, endDate: options.endDate });
      return { payload: {} };
    }
  };

  const scheduled = await runPolTrackerScheduler(common);
  assert.equal(scheduled.published, true);
  assert.deepEqual(calls.slice(0, 4), [
    { type: 'lock', key: 'boonetools:pol-tracker' },
    { type: 'ingest', startDate: '2026-08-11', endDate: '2026-08-17' },
    { type: 'build', startDate: '2025-02-01', endDate: '2026-08-17' },
    { type: 'publish', key: 'pol-tracker:v2' }
  ]);

  calls.length = 0;
  await runPolTrackerBackfill(common);
  assert.deepEqual(calls[1], {
    type: 'ingest',
    startDate: '2025-02-01',
    endDate: '2026-08-17'
  });
  assert.deepEqual(calls[2], {
    type: 'build',
    startDate: '2025-02-01',
    endDate: '2026-08-17'
  });
});
