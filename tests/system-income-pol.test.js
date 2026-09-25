import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSystemIncomePolDepositOption } from '../src/lib/system-income-pol/charts.js';

import {
  SYSTEM_INCOME_POL_RANGES,
  applySystemIncomePolHead,
  buildSystemIncomePolAssetInventory,
  buildSystemIncomePolChart,
  buildSystemIncomePolFeeChart,
  formatE8Asset,
  formatE8Rune,
  formatE8Usd,
  formatPercent,
  normalizeSystemIncomePolPayload,
  selectSystemIncomePolRange
} from '../src/lib/system-income-pol/model.js';

test('daily fee details remain dismissible and keyboard/touch accessible after migration', async () => {
  const source = await readFile(new URL('../src/lib/system-income-pol/DailyFeeChart.svelte', import.meta.url), 'utf8');
  assert.match(source, /id="daily-fees-tooltip"[^>]*role="tooltip"/);
  assert.match(source, /<TimeSeriesChart/);
  assert.match(source, /onSelect=\{pinDay\}/);
  assert.match(source, /<label for="pol-fee-day">/);
  assert.match(source, /<select id="pol-fee-day" bind:value=\{selectedDay\}/);
  assert.match(source, /aria-describedby=\{selected \? 'daily-fees-tooltip'/);
  assert.match(source, /on:focus=/);
  assert.match(source, /on:pointerdown=\{dismissOutside\}/);
  assert.match(source, /event.key === 'Escape'/);
  assert.match(source, /polFeeDetails\(selected, unit\)/);
  assert.match(source, /PARTIAL \/ PROVISIONAL/);
  assert.match(source, /<button[^>]*on:click=\{dismissTooltip\}/);
  assert.doesNotMatch(source, /<svg|<title>|class="readout"/);
});

test('daily fee bars use daily estimates and historical prices, not cumulative fees or deposits', () => {
  const { daily } = normalizeSystemIncomePolPayload({ daily: [
    { day: '2026-09-01', estimated_fees_e8: '100000000', cumulative_estimated_fees_e8: '9000000000', deployed_e8: '50000000000', rune_price_usd: '2' },
    { day: '2026-09-02', estimated_fees_e8: '300000000', cumulative_estimated_fees_e8: '9300000000', rune_price_usd: '4', partial: true, fee_coverage: { covered_hours: 3, total_hours: 3, seeded_hours: 1, provisional_hours: 1 } }
  ] });
  const usd = buildSystemIncomePolFeeChart(daily, { unit: 'usd', width: 360 });
  const rune = buildSystemIncomePolFeeChart(daily, { unit: 'rune' });
  assert.deepEqual(usd.points.filter(point => point.value !== null).map(point => point.value), [2, 12]);
  assert.deepEqual(rune.points.filter(point => point.value !== null).map(point => point.value), [1, 3]);
  assert.deepEqual(daily[1].feeCoverage, { coveredHours: 3, totalHours: 3, seededHours: 1, provisionalHours: 1 });
  assert.equal(usd.points[1].provisional, true);
  assert.equal(usd.points[0].provisional, false);
  assert.deepEqual(buildSystemIncomePolFeeChart(daily.slice(1)).points.map(bar => bar.value), [12]);
});

test('daily fee chart distinguishes missing estimates, unpriced fees and known zero days', () => {
  const { daily } = normalizeSystemIncomePolPayload({ daily: [
    { day: '2026-09-01', estimated_fees_e8: null, rune_price_usd: '2' },
    { day: '2026-09-02', estimated_fees_e8: '200000000' },
    { day: '2026-09-03', estimated_fees_e8: '0' },
    { day: '2026-09-04', estimated_fees_e8: '100000000', rune_price_usd: '3', price_provisional: true }
  ] });
  const usd = buildSystemIncomePolFeeChart(daily);
  assert.equal(usd.missingDays, 2);
  assert.deepEqual(usd.points.map(point => point.value), [null, null, 0, 3]);
  assert.equal(usd.points[0].missingReason, 'Fee estimate unavailable');
  assert.equal(usd.points[1].missingReason, 'Daily USD price unavailable');
  assert.equal(usd.points[2].value, 0);
  assert.equal(usd.points[3].provisional, true);
  const rune = buildSystemIncomePolFeeChart(daily, { unit: 'rune' });
  assert.equal(rune.missingDays, 1);
  assert.deepEqual(rune.points.filter(point => point.value !== null).map(point => point.value), [2, 0, 1]);
  assert.equal(rune.points.at(-1).provisional, false);
});

test('daily fee chart handles empty and all-missing ranges without fabricated bars', () => {
  for (const daily of [[], normalizeSystemIncomePolPayload({ daily: [{ day: '2026-09-01' }] }).daily]) {
    const chart = buildSystemIncomePolFeeChart(daily, { width: 300 });
    assert.ok(chart.points.every(point => point.value === null));
    assert.equal(chart.points.length, daily.length);
    assert.equal(chart.missingDays, daily.length);
  }
});

test('estimated-fees headline owns an accessible, initially collapsed daily chart', async () => {
  const source = await readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8');
  assert.match(source, /let feesExpanded = false/);
  assert.match(source, /<button\s+type="button"\s+class="metric metric--fees metric-toggle"[\s\S]*?aria-expanded=\{feesExpanded\}[\s\S]*?aria-controls="pol-fees-history"[\s\S]*?on:click=\{\(\) => feesExpanded = !feesExpanded\}/);
  assert.match(source, /id="pol-fees-history" hidden=\{!feesExpanded\}/);
  assert.match(source, /<DailyFeeChart daily=\{dashboard.daily\}/);
  assert.doesNotMatch(source, /fee-toggle-hint|(?:VIEW|HIDE) DAILY FEES/);
  assert.doesNotMatch(source, /\.metric-toggle\[aria-expanded="true"\]/);
});

test('System Income POL owns /pol-tracker and appears in navigation', async () => {
  const [appSource, dashboardSource] = await Promise.all([
    readFile(new URL('../src/App.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8')
  ]);
  const visibleApps = appSource.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';
  const hiddenApps = appSource.match(/const hiddenApps = \[([\s\S]*?)\];/)?.[1] || '';

  assert.match(appSource, /const systemIncomePolApp = \{/);
  assert.match(appSource, /path: "pol-tracker"/);
  assert.equal(visibleApps.includes('systemIncomePolApp'), true);
  assert.equal(hiddenApps.includes('systemIncomePolApp'), false);
  assert.match(dashboardSource, /SYSTEM INCOME POL/);
  assert.match(dashboardSource, /subscribeChainHeads/);
  assert.doesNotMatch(dashboardSource, /freshness-strip/);
  assert.doesNotMatch(dashboardSource, /LIVE · BLOCK/);
  assert.match(dashboardSource, /POL TVL/);
  assert.match(dashboardSource, /RUNE DEPOSITED/);
  assert.match(dashboardSource, /class="deployment-pulse"/);
  assert.match(dashboardSource, /window\.setTimeout\([\s\S]*?, 1000\)/);
  assert.doesNotMatch(dashboardSource, /deployment-tape/);
  assert.match(dashboardSource, /EST\. FEES EARNED/);
  assert.match(dashboardSource, /24H EST\. APR/);
  assert.match(dashboardSource, /7D EST\. FEE APR/);
  assert.match(dashboardSource, /30D EST\. FEE APR/);
  assert.match(dashboardSource, /HOURLY/);
  assert.match(dashboardSource, /SYSTEM INCOME → POL/);
  assert.match(dashboardSource, /polReserveSystemIncomePercent/);
  assert.match(dashboardSource, /POLRESERVESYSTEMINCOMEBPS/);
  assert.match(dashboardSource, /RUNE “BURNED”/);
  assert.match(dashboardSource, /runeHeldSystemIncomeSharePercent, 1/);
  assert.match(dashboardSource, /DAILY \+ CUMULATIVE POL DEPOSITS/);
  assert.match(dashboardSource, /let chartUnit = 'rune'/);
  assert.match(dashboardSource, /aria-label="Chart denomination"/);
  assert.match(dashboardSource, /<CurrencySwitch unit=\{chartUnit\} usdAvailable=\{usdChartAvailable\}/);
  assert.match(dashboardSource, /onChange=\{setChartUnit\}/);
  assert.match(dashboardSource, /daily\.some\(row => Number\.isFinite\(row\.deployedUsd\)\)/);
  assert.doesNotMatch(dashboardSource, /USD values use the current RUNE price/);
  assert.match(dashboardSource, /USD deposits use each UTC day's closing RUNE price/);
  assert.match(dashboardSource, /buildSystemIncomePolChart\(dashboard.daily/);
  assert.match(dashboardSource, /selectSystemIncomePolRange\(chart.points/);
  assert.match(dashboardSource, /\{#if rangeRows.length\}/);
  assert.match(dashboardSource, /<TimeSeriesChart bind:this=\{depositChart\}/);
  assert.match(dashboardSource, /buildOption=\{buildSystemIncomePolDepositOption\}/);
  assert.match(dashboardSource, /onZoom=\{\(window\) => zoomWindow = window\}/);
  assert.match(dashboardSource, /depositChart\?\.resetZoom\(\)/);
  assert.doesNotMatch(dashboardSource, /<svg|zoom-capture/);
  assert.match(dashboardSource, /\.range-group \{ flex-wrap: wrap; \}/);
  assert.match(dashboardSource, />\[RESET\]<\/button>/);
  assert.match(dashboardSource, /class="token-name"/);
  assert.match(dashboardSource, /getAssetLogo\('THOR\.RUNE'\)/);
  assert.match(dashboardSource, /getAssetLogo\(pool\.asset\)/);
  assert.match(dashboardSource, /metric-separator[^>]*>\/<\/span>/);
  assert.match(dashboardSource, /class="metric-rune-icon"[^>]*RUNE-ICON\.svg/);
  assert.match(dashboardSource, /\.asset-panel \.panel-heading > div:first-child \{ padding-left: 0; \}/);
  assert.match(dashboardSource, /let rangeId = '30d'/);
  assert.match(dashboardSource, /visibleWarnings/);
  assert.doesNotMatch(dashboardSource, /#each dashboard\.warnings/);
  assert.match(dashboardSource, /metric-value--orange/);
  assert.match(dashboardSource, /metric-value--green/);
  assert.match(dashboardSource, /getAssetLogo/);
  assert.match(dashboardSource, /https:\/\/thorchain\.net\/pool\//);
  assert.match(dashboardSource, /https:\/\/thorchain\.net\/address\//);
  assert.match(dashboardSource, /rel="noopener noreferrer"/);
  assert.doesNotMatch(dashboardSource, /--term-green/);
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

test('System Income POL muted copy keeps a readable contrast and type floor', async () => {
  const dashboardSource = await readFile(
    new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url),
    'utf8'
  );

  assert.match(dashboardSource, /\.metric-label \{[^}]*color: var\(--term-text-3\)/);
  assert.match(dashboardSource, /\.metric small \{[^}]*color: var\(--term-text-3\);[^}]*font-size: 12px/);
  assert.match(dashboardSource, /\.panel-meta \{[^}]*color: var\(--term-text-3\);[^}]*font-size: 12px/);
  assert.match(dashboardSource, /\.asset-grid span, \.asset-grid small \{[^}]*color: var\(--term-text-3\);[^}]*font-size: 12px/);
  const option = buildSystemIncomePolDepositOption([]);
  assert.ok(option.yAxis.every(axis => axis.axisLabel.fontSize >= 11));
  assert.ok(option.tooltip.textStyle.fontSize >= 12);
  assert.match(dashboardSource, /\.method-panel > p \{[^}]*color: var\(--term-text-2\);[^}]*font: 14px/);
});

test('System Income POL normalization preserves exact base-unit accounting', () => {
  const dashboard = normalizeSystemIncomePolPayload({
    as_of: '2026-08-31T12:00:00Z',
    module_address: 'thor1polmodule',
    summary: {
      total_funded_e8: '1200000000',
      total_system_income_e8: '12000000000',
      system_income_pol_share_bps: 1000,
      pol_reserve_system_income_bps: 2000,
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
      fee_hours_covered: 17,
      fee_hours_total: 18,
      fee_hours_seeded: 4,
      fee_hours_provisional: 1,
      estimated_fee_apr: {
        '24h': {
          estimated_fee_apr_bps: 6543.21,
          target_hours: 24,
          available_hours: 18,
          covered_hours: 17,
          measured_hours: 13,
          seeded_hours: 4,
          status: 'warming',
          complete: false
        },
        '7d': {
          estimated_fee_apr_bps: 6000,
          target_hours: 168,
          available_hours: 18,
          covered_hours: 17,
          measured_hours: 13,
          seeded_hours: 4,
          status: 'warming',
          complete: false
        },
        '30d': {
          estimated_fee_apr_bps: 5500,
          target_hours: 720,
          available_hours: 18,
          covered_hours: 17,
          measured_hours: 13,
          seeded_hours: 4,
          status: 'warming',
          complete: false
        }
      },
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
      cumulative_deployed_e8: '900000000',
      cumulative_estimated_fees_e8: '60000000'
    }],
    live: { through_height: 123, through_time: '2026-08-31T12:00:00Z' },
    freshness: { events_as_of: '2026-08-31T12:00:00Z' }
  });

  assert.equal(dashboard.summary.totalFundedE8, '1200000000');
  assert.equal(dashboard.moduleAddress, 'thor1polmodule');
  assert.equal(dashboard.summary.totalPositionValueUsdE8, '1920000000');
  assert.equal(dashboard.summary.systemIncomePolSharePercent, 10);
  assert.equal(dashboard.summary.polReserveSystemIncomePercent, 20);
  assert.equal(dashboard.summary.activePoolCount, 2);
  assert.equal(dashboard.summary.feeHoursCovered, 17);
  assert.equal(dashboard.summary.feeHoursSeeded, 4);
  assert.equal(dashboard.summary.feeHoursProvisional, 1);
  assert.equal(dashboard.summary.feeAprWindows['24h'].aprPercent, 65.4321);
  assert.equal(dashboard.summary.feeAprWindows['24h'].status, 'warming');
  assert.equal(dashboard.summary.feeAprWindows['7d'].targetHours, 168);
  assert.equal(dashboard.pools[0].assetHeldE8, '1234567');
  assert.equal(dashboard.daily[0].cumulativeDeployedE8, '900000000');
  assert.equal(dashboard.daily[0].cumulativeEstimatedFeesRune, 0.6);
  assert.equal(dashboard.liveHeight, 123);
  assert.equal(formatE8Rune('1200000000'), '12.00');
  assert.equal(formatE8Asset('1234567'), '0.012346');
  assert.equal(formatE8Usd('1920000000'), '$19.20');
  assert.equal(formatPercent(9.94, 1), '9.9%');
  assert.equal(formatPercent(9.9883, 1), '10.0%');
  assert.deepEqual(buildSystemIncomePolAssetInventory(dashboard.summary, dashboard.pools), [{
    asset: 'THOR.RUNE', ticker: 'RUNE', amountE8: '470000000', valueUsdE8: '940000000'
  }, {
    asset: 'BTC.BTC', ticker: 'BTC', amountE8: '1234567', valueUsdE8: '980000000'
  }]);
});

test('POL depth increase compares liquidity with the non-POL baseline', () => {
  const depthIncrease = (shareBps) => normalizeSystemIncomePolPayload({
    pools: [{ asset: 'TRON.USDT', share_bps: shareBps }]
  }).pools[0].depthIncreasePercent;

  assert.equal(depthIncrease(2000), 25); // 20 POL + 80 other = 25% deeper than 80.
  assert.equal(depthIncrease(5000), 100);
  assert.equal(depthIncrease(0), 0);
  assert.equal(formatPercent(depthIncrease(2174.12), 1), '27.8%');
  for (const unavailable of [null, undefined, '', -1, 10000, 10001, Infinity, 'invalid']) {
    assert.equal(depthIncrease(unavailable), null);
  }
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

test('System Income POL history exposes ranges and display values', () => {
  assert.deepEqual(SYSTEM_INCOME_POL_RANGES.map(({ id }) => id), ['30d', '90d', '180d', 'all']);
  const rows = Array.from({ length: 200 }, (_, index) => ({
    day: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
    fundedRune: index + 1,
    deployedRune: index / 2,
    estimatedFeesRune: index / 10
  }));
  assert.equal(selectSystemIncomePolRange(rows).length, 30);
  assert.equal(selectSystemIncomePolRange(rows, 'all').length, 200);
  const chart = buildSystemIncomePolChart(rows.slice(0, 30));
  assert.equal(chart.points.length, 30);
  assert.ok(chart.points.every(point => Number.isFinite(point.depositedPlotValue)));
});

test('System Income POL history charts each day\'s POL deposit as a bar', () => {
  const chart = buildSystemIncomePolChart([{
    day: '2026-08-31',
    fundedRune: 700,
    deployedRune: 690,
    estimatedFeesRune: 2,
    cumulativeFundedRune: 700,
    cumulativeDeployedRune: 690,
    cumulativeEstimatedFeesRune: 2
  }, {
    day: '2026-09-01',
    fundedRune: 60,
    deployedRune: 55,
    estimatedFeesRune: 1,
    cumulativeFundedRune: 760,
    cumulativeDeployedRune: 745,
    cumulativeEstimatedFeesRune: 3
  }]);

  assert.deepEqual(chart.points.map((point) => point.depositedPlotRune), [690, 55]);
  assert.deepEqual(chart.points.map((point) => point.cumulativeDepositedRune), [690, 745]);
  assert.deepEqual(chart.points.map((point) => point.depositedPlotValue), [690, 55]);
});

test('System Income POL USD deposits use daily prices and sum historic dollars before range selection', () => {
  const { daily: rows } = normalizeSystemIncomePolPayload({ daily: [{
    day: '2026-08-31',
    deployed_e8: '69000000000',
    cumulative_deployed_e8: '69000000000',
    rune_price_usd: '2'
  }, {
    day: '2026-09-01',
    deployed_e8: '5500000000',
    cumulative_deployed_e8: '74500000000',
    rune_price_usd: '3'
  }] });
  const chart = buildSystemIncomePolChart(rows, {
    unit: 'usd',
    runePriceUsdE8: '900000000'
  });

  assert.equal(chart.unit, 'usd');
  assert.equal(chart.unitAvailable, true);
  assert.deepEqual(chart.points.map((point) => point.depositedPlotValue), [1380, 165]);
  assert.deepEqual(chart.points.map((point) => point.cumulativeDepositedValue), [1380, 1545]);
  assert.deepEqual(chart.points.map((point) => point.depositedPlotRune), [690, 55]);
  const zoomed = buildSystemIncomePolChart(rows.slice(1), { unit: 'usd' });
  assert.equal(zoomed.points[0].cumulativeDepositedValue, 1545);
});

test('System Income POL USD history leaves missing daily prices unknown', () => {
  const { daily } = normalizeSystemIncomePolPayload({ daily: [
    { day: '2026-08-31', deployed_e8: '100000000', rune_price_usd: '2' },
    { day: '2026-09-01', deployed_e8: '100000000', rune_price_usd: null },
    { day: '2026-09-02', deployed_e8: '100000000', rune_price_usd: '3', price_provisional: true }
  ] });
  const chart = buildSystemIncomePolChart(daily, { unit: 'usd', runePriceUsdE8: '900000000' });
  assert.deepEqual(chart.points.map(point => point.depositedPlotValue), [2, null, 3]);
  assert.deepEqual(chart.points.map(point => point.cumulativeDepositedValue), [2, null, null]);
  assert.equal(chart.points.filter(point => Number.isFinite(point.depositedPlotValue)).length, 2);
});

test('live POL deposits retain their day price and midnight never borrows yesterday’s price', () => {
  const payload = {
    summary: { rune_price_usd_e8: '900000000' },
    live: { through_height: 10 },
    daily: [{ day: '2026-09-01', deployed_e8: '100000000', rune_price_usd: '2', price_provisional: true }]
  };
  const head = {
    height: 11, time: '2026-09-01T23:59:59Z',
    pol_reserve_deployments: [{ asset: 'TRON.USDT', rune_e8: '100000000' }]
  };
  const sameDay = normalizeSystemIncomePolPayload(applySystemIncomePolHead(payload, head));
  assert.equal(sameDay.daily[0].deployedUsd, 4);
  assert.equal(sameDay.daily[0].priceProvisional, true);
  const nextDay = normalizeSystemIncomePolPayload(applySystemIncomePolHead(payload, {
    ...head, time: '2026-09-02T00:00:01Z'
  }));
  assert.equal(nextDay.daily[0].deployedUsd, 2);
  assert.equal(nextDay.daily[1].deployedUsd, null);
  assert.equal(nextDay.daily[1].cumulativeDeployedUsd, null);
});

test('zero POL deposits do not require a price or invalidate the cumulative dollars', () => {
  const { daily } = normalizeSystemIncomePolPayload({ daily: [
    { day: '2026-08-31', deployed_e8: '100000000', rune_price_usd: '2' },
    { day: '2026-09-01', deployed_e8: '0', rune_price_usd: null },
    { day: '2026-09-02', deployed_e8: '100000000', rune_price_usd: '3' }
  ] });
  assert.deepEqual(daily.map(row => row.cumulativeDeployedUsd), [2, 2, 5]);
});

test('POL fallback cumulative RUNE is calculated before range selection', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    day: new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10),
    deployedRune: 2, cumulativeDeployedRune: null
  }));
  const points = buildSystemIncomePolChart(rows).points;
  const selected = selectSystemIncomePolRange(points, '30d');
  assert.equal(selected[0].cumulativeDepositedValue, 22);
  assert.equal(selected.at(-1).cumulativeDepositedValue, 80);
  assert.equal(selected[0].depositedPlotValue, 2);
});
