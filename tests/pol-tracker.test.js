import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  POL_TRACKER_GROUPS,
  POL_TRACKER_RANGES,
  POL_TRACKER_SERIES,
  buildPolTrackerChart,
  normalizePolTrackerPayload,
  projectPolTrackerChartSelection,
  relevantPolTrackerPools,
  selectPolTrackerRange,
  totalPolTrackerValue
} from '../src/lib/pol-tracker/model.js';

test('POL Tracker is directly routable and appears in navigation', async () => {
  const [appSource, trackerSource] = await Promise.all([
    readFile(new URL('../src/App.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/POLTracker.svelte', import.meta.url), 'utf8')
  ]);
  const visibleApps = appSource.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';

  assert.equal(visibleApps.includes('polTrackerApp'), true);
  assert.match(appSource, /const hiddenApps = \[wasmArbEconomicsApp\];/);
  assert.match(appSource, /return \[\.\.\.apps, \.\.\.hiddenApps\]\.find/);
  assert.doesNotMatch(trackerSource, /SAVERS|Savers|Saver/);
  assert.doesNotMatch(trackerSource, /ASSET LEG|RUNE LEG|treasuryAssetUsd|treasuryRuneUsd/);
  assert.doesNotMatch(trackerSource, /RUNEPOOL · RESERVE SHARE|runepoolReserve/);
  assert.match(trackerSource, />TOTAL</);
  assert.match(trackerSource, /class="metric metric--total"/);
  assert.match(trackerSource, />TOTAL TRACKED VALUE</);
  assert.match(trackerSource, /formatPolTrackerUsd\(latestTotal, true\)/);
  assert.match(trackerSource, /\.metric--total\s*\{[\s\S]*?color:\s*#00cc66/);
  assert.match(trackerSource, /<th>RESERVE POL<\/th>/);
  assert.match(trackerSource, /pool\.reservePolUsd/);
  assert.match(trackerSource, /DRAG TO ZOOM · DOUBLE-CLICK RESET/);
  assert.match(trackerSource, /on:pointerdown=\{startZoomSelection\}/);
  assert.match(trackerSource, /on:dblclick=\{resetZoom\}/);
  assert.match(trackerSource, /class="zoom-selection"/);
});

test('POL Tracker exposes exactly three consolidated public chart values', () => {
  const ids = POL_TRACKER_SERIES.map(({ id }) => id);
  assert.deepEqual(ids, ['synth', 'treasury_total', 'reserve_pol']);
  assert.equal(POL_TRACKER_GROUPS.length, 1);
});

test('POL Tracker exposes the requested date-range presets above the chart', () => {
  assert.deepEqual(POL_TRACKER_RANGES, [
    { id: '30d', label: '30D', days: 30 },
    { id: '90d', label: '90D', days: 90 },
    { id: '180d', label: '180D', days: 180 },
    { id: 'all', label: 'ALL TIME', days: null }
  ]);
});

test('POL Tracker normalization ignores Savers, Treasury legs, and RUNEPool ownership', () => {
  const dashboard = normalizePolTrackerPayload({
    daily: [{
      day: '2025-02-01',
      height: 123,
      savers_usd: 20,
      synth: { backing_usd: 30 },
      treasury_lp: { asset_leg_usd: 4, rune_leg_usd: 5, total_usd: 9 },
      reserve_pol: { deployed_rune: 10, deployed_usd: 20 },
      runepool: {
        reserve_owned_rune: 6,
        reserve_owned_usd: 12,
        provider_owned_rune: 4,
        provider_owned_usd: 8
      }
    }],
    latest_pools: [{
      asset: 'BTC.BTC',
      savers_depth: 10,
      savers_usd: 20,
      synth_backing_usd: 30,
      treasury_asset_usd: 4,
      treasury_rune_usd: 5,
      treasury_total_usd: 9,
      reserve_pol_rune: 10,
      reserve_pol_usd: 20
    }]
  });
  assert.equal(dashboard.daily[0].treasuryTotalUsd, 9);
  assert.equal(Object.hasOwn(dashboard.daily[0], 'saversUsd'), false);
  assert.equal(Object.hasOwn(dashboard.daily[0], 'treasuryAssetUsd'), false);
  assert.equal(Object.hasOwn(dashboard.daily[0], 'treasuryRuneUsd'), false);
  assert.equal(Object.hasOwn(dashboard.daily[0], 'runepoolReserveRune'), false);
  assert.equal(Object.hasOwn(dashboard.daily[0], 'runepoolReserveUsd'), false);
  assert.equal(Object.keys(dashboard.daily[0]).some((key) => key.includes('provider')), false);
  assert.equal(Object.hasOwn(dashboard.latestPools[0], 'saversDepth'), false);
  assert.equal(Object.hasOwn(dashboard.latestPools[0], 'saversUsd'), false);
  assert.equal(Object.hasOwn(dashboard.latestPools[0], 'treasuryAssetUsd'), false);
  assert.equal(Object.hasOwn(dashboard.latestPools[0], 'treasuryRuneUsd'), false);
  assert.equal(dashboard.latestPools[0].reservePolRune, 10);
  assert.equal(dashboard.latestPools[0].reservePolUsd, 20);
});

test('the latest-pool table keeps pools whose only tracked value is Reserve POL', () => {
  const pools = relevantPolTrackerPools([
    { asset: 'BTC.BTC', synthBackingUsd: 0, treasuryTotalUsd: 0, reservePolUsd: 20 },
    { asset: 'ETH.ETH', synthBackingUsd: 0, treasuryTotalUsd: 0, reservePolUsd: 0 }
  ]);
  assert.deepEqual(pools.map(({ asset }) => asset), ['BTC.BTC']);
});

test('the consolidated chart stacks three shaded areas and totals their values', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    day: `2025-03-${String(index + 1).padStart(2, '0')}`,
    synthBackingUsd: index === 20 ? null : 10,
    treasuryTotalUsd: 20,
    reservePolUsd: 30,
    runepoolReserveUsd: 40
  }));
  const selected = selectPolTrackerRange(rows, '30d');
  assert.equal(selected.length, 30);
  const chart = buildPolTrackerChart(selected, 'overview');
  assert.equal(chart.yMax, 100);
  assert.equal(chart.paths.length, 3);
  assert.ok(chart.paths.every(({ areaPath }) => areaPath.includes('Z')));
  const synthPath = chart.paths.find(({ id }) => id === 'synth').path;
  assert.ok((synthPath.match(/M/g) || []).length >= 2);
  assert.equal(totalPolTrackerValue(rows[0]), 60);
  assert.equal(totalPolTrackerValue(rows[20]), null);
});

test('POL Tracker drag selection projects either direction into a bounded chart zoom', () => {
  const forward = projectPolTrackerChartSelection({
    rowCount: 101,
    plotLeft: 82,
    plotRight: 984,
    startX: 307.5,
    endX: 758.5
  });
  const reverse = projectPolTrackerChartSelection({
    rowCount: 101,
    plotLeft: 82,
    plotRight: 984,
    startX: 758.5,
    endX: 307.5
  });

  assert.deepEqual(forward, { startIndex: 25, endIndex: 75 });
  assert.deepEqual(reverse, forward);
  assert.equal(projectPolTrackerChartSelection({
    rowCount: 101,
    plotLeft: 82,
    plotRight: 984,
    startX: 400,
    endX: 405
  }), null);
  assert.deepEqual(projectPolTrackerChartSelection({
    rowCount: 11,
    plotLeft: 82,
    plotRight: 984,
    startX: -100,
    endX: 2_000
  }), { startIndex: 0, endIndex: 10 });
});
