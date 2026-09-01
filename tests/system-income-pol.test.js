import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SYSTEM_INCOME_POL_RANGES,
  applySystemIncomePolHead,
  buildSystemIncomePolAssetInventory,
  buildSystemIncomePolChart,
  formatE8Asset,
  formatE8Rune,
  formatE8Usd,
  normalizeSystemIncomePolPayload,
  selectSystemIncomePolRange
} from '../src/lib/system-income-pol/model.js';

test('System Income POL owns /pol-tracker but stays out of navigation', async () => {
  const [appSource, dashboardSource] = await Promise.all([
    readFile(new URL('../src/App.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8')
  ]);
  const visibleApps = appSource.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';
  const hiddenApps = appSource.match(/const hiddenApps = \[([\s\S]*?)\];/)?.[1] || '';

  assert.match(appSource, /const systemIncomePolApp = \{/);
  assert.match(appSource, /path: "pol-tracker"/);
  assert.equal(visibleApps.includes('systemIncomePolApp'), false);
  assert.equal(hiddenApps.includes('systemIncomePolApp'), true);
  assert.match(dashboardSource, /SYSTEM INCOME POL/);
  assert.match(dashboardSource, /subscribeChainHeads/);
  assert.match(dashboardSource, /LIVE · BLOCK/);
  assert.match(dashboardSource, /POSITIONS/);
  assert.match(dashboardSource, /FEES/);
  assert.match(dashboardSource, /POL TVL/);
  assert.match(dashboardSource, /RUNE DEPOSITED/);
  assert.match(dashboardSource, /EST\. FEES EARNED/);
  assert.match(dashboardSource, /SYSTEM INCOME → POL/);
  assert.match(dashboardSource, /RUNE “BURNED”/);
  assert.match(dashboardSource, /CURRENT ASSETS HELD BY POL/);
  assert.match(dashboardSource, /formatE8Usd\(pool\.positionValueUsdE8\)/);
  assert.match(dashboardSource, /DATA COVERAGE/);
});

test('System Income POL coverage rendering exposes coverage as a template dependency', async () => {
  const dashboardSource = await readFile(
    new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url),
    'utf8'
  );

  assert.match(dashboardSource, /function coverageValue\(source, \.\.\.keys\)/);
  assert.match(dashboardSource, /coverageValue\(coverage, 'first_height', 'start_height'\)/);
  assert.doesNotMatch(dashboardSource, /const value = coverage\?\.\[key\]/);
});

test('System Income POL normalization preserves exact base-unit accounting', () => {
  const dashboard = normalizeSystemIncomePolPayload({
    as_of: '2026-08-31T12:00:00Z',
    summary: {
      total_funded_e8: '1200000000',
      total_system_income_e8: '12000000000',
      system_income_pol_share_bps: 1000,
      total_deployed_e8: '900000000',
      undeployed_rune_e8: '300000000',
      total_position_value_rune_e8: '960000000',
      total_position_value_usd_e8: '1920000000',
      total_rune_held_e8: '470000000',
      total_rune_held_usd_e8: '940000000',
      rune_held_system_income_share_bps: 391.66,
      total_asset_value_rune_e8: '490000000',
      total_estimated_fees_e8: '60000000',
      total_estimated_fees_usd_e8: '120000000',
      active_pool_count: 2
    },
    pools: [{
      asset: 'BTC.BTC',
      units_e8: '500',
      total_pool_units_e8: '10000',
      share_bps: 500,
      rune_deposited_e8: '900000000',
      rune_held_e8: '470000000',
      asset_held_e8: '1234567',
      asset_value_usd_e8: '980000000',
      position_value_rune_e8: '960000000',
      position_value_usd_e8: '1920000000',
      estimated_fees_e8: '60000000',
      status: 'Available'
    }],
    daily: [{
      day: '2026-08-31',
      funded_e8: '1200000000',
      deployed_e8: '900000000',
      estimated_fees_e8: '60000000',
      cumulative_funded_e8: '1200000000',
      cumulative_deployed_e8: '900000000'
    }],
    live: { through_height: 123, through_time: '2026-08-31T12:00:00Z' },
    freshness: { events_as_of: '2026-08-31T12:00:00Z' }
  });

  assert.equal(dashboard.summary.totalFundedE8, '1200000000');
  assert.equal(dashboard.summary.totalPositionValueUsdE8, '1920000000');
  assert.equal(dashboard.summary.systemIncomePolSharePercent, 10);
  assert.equal(dashboard.summary.activePoolCount, 2);
  assert.equal(dashboard.pools[0].assetHeldE8, '1234567');
  assert.equal(dashboard.daily[0].cumulativeDeployedE8, '900000000');
  assert.equal(dashboard.liveHeight, 123);
  assert.equal(formatE8Rune('1200000000'), '12.00');
  assert.equal(formatE8Asset('1234567'), '0.012346');
  assert.equal(formatE8Usd('1920000000'), '$19.20');
  assert.deepEqual(buildSystemIncomePolAssetInventory(dashboard.summary, dashboard.pools), [{
    asset: 'THOR.RUNE', ticker: 'RUNE', amountE8: '470000000', valueUsdE8: '940000000'
  }, {
    asset: 'BTC.BTC', ticker: 'BTC', amountE8: '1234567', valueUsdE8: '980000000'
  }]);
});

test('streamed SIPOL events apply once and advance exact cash-flow state', () => {
  const initial = {
    as_of: '2026-08-31T12:00:00Z',
    summary: {
      total_funded_e8: '100',
      total_system_income_e8: '1000',
      total_rune_held_e8: '30',
      total_deployed_e8: '40',
      undeployed_rune_e8: '60'
    },
    pools: [{ asset: 'BTC.BTC', rune_deposited_e8: '40', units_e8: '9' }],
    daily: [{ day: '2026-08-31', funded_e8: '100', deployed_e8: '40' }],
    live: { through_height: 9, through_time: '2026-08-31T12:00:00Z' }
  };
  const head = {
    height: 10,
    time: '2026-08-31T12:00:06Z',
    pol_reserve_reward_e8: '15',
    system_income_e8: '100',
    pol_reserve_deployments: [
      { asset: 'BTC.BTC', rune_e8: '7', units_e8: '3' },
      { asset: 'ETH.ETH', rune_e8: '2', units_e8: '1' }
    ]
  };
  const next = applySystemIncomePolHead(initial, head);

  assert.equal(next.summary.total_funded_e8, '115');
  assert.equal(next.summary.total_deployed_e8, '49');
  assert.equal(next.summary.total_system_income_e8, '1100');
  assert.equal(next.summary.system_income_pol_share_bps, 1045.45);
  assert.equal(next.summary.undeployed_rune_e8, '60');
  assert.equal(next.pools[0].rune_deposited_e8, '47');
  assert.equal(next.pools[0].units_e8, '9');
  assert.equal(next.pools[1].asset, 'ETH.ETH');
  assert.equal(next.pools[1].units_e8, null);
  assert.equal(next.daily[0].funded_e8, '115');
  assert.equal(next.daily[0].deployed_e8, '49');
  assert.equal(next.live.through_height, 10);
  assert.equal(applySystemIncomePolHead(next, head), next);

  const nextDay = applySystemIncomePolHead(initial, {
    ...head,
    time: '2026-09-01T00:00:06Z'
  });
  assert.equal(nextDay.daily.find((row) => row.day === '2026-09-01').estimated_fees_e8, null);
});

test('streamed SIPOL deployments never mutate reconciled LP units', () => {
  const initial = {
    summary: {
      total_funded_e8: '10',
      total_deployed_e8: '5',
      undeployed_rune_e8: '5'
    },
    pools: [{ asset: 'BTC.BTC', rune_deposited_e8: '5', units_e8: '7' }],
    daily: [],
    live: { through_height: 9, through_time: '2026-08-31T12:00:00Z' }
  };
  const next = applySystemIncomePolHead(initial, {
    height: 10,
    time: '2026-08-31T12:00:06Z',
    pol_reserve_deployments: [
      { asset: 'BTC.BTC', rune_e8: '2', units_e8: '9' },
      { asset: 'ETH.ETH', rune_e8: '3', units_e8: null }
    ]
  });

  assert.equal(next.pools[0].units_e8, '7');
  assert.equal(next.pools[1].units_e8, null);
});

test('unknown undeployed RUNE stays unknown through normalization and live heads', () => {
  const initial = {
    summary: {
      total_funded_e8: '10',
      total_deployed_e8: '5',
      undeployed_rune_e8: null
    },
    pools: [],
    daily: [],
    live: { through_height: 9, through_time: '2026-08-31T12:00:00Z' }
  };
  const next = applySystemIncomePolHead(initial, {
    height: 10,
    time: '2026-08-31T12:00:06Z',
    pol_reserve_reward_e8: '2'
  });

  assert.equal(next.summary.undeployed_rune_e8, null);
  assert.equal(normalizeSystemIncomePolPayload(next).summary.undeployedRuneE8, null);
});

test('System Income POL history exposes ranges and chart geometry', () => {
  assert.deepEqual(SYSTEM_INCOME_POL_RANGES.map(({ id }) => id), ['30d', '90d', '180d', 'all']);
  const rows = Array.from({ length: 200 }, (_, index) => ({
    day: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
    fundedRune: index + 1,
    deployedRune: index / 2,
    estimatedFeesRune: index / 10
  }));
  assert.equal(selectSystemIncomePolRange(rows).length, 90);
  assert.equal(selectSystemIncomePolRange(rows, 'all').length, 200);
  const chart = buildSystemIncomePolChart(rows.slice(0, 30));
  assert.equal(chart.points.length, 30);
  assert.match(chart.fundedPath, /^M/);
  assert.match(chart.deployedPath, /^M/);
  assert.match(chart.feesPath, /^M/);
});
