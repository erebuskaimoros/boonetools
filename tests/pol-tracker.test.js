import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  POL_TRACKER_GROUPS,
  POL_TRACKER_RANGES,
  POL_TRACKER_SERIES,
  polTrackerStackValues,
  normalizePolTrackerPayload,
  relevantPolTrackerPools,
  selectPolTrackerRange,
  totalPolTrackerValue
} from '../src/lib/pol-tracker/model.js';

test('legacy POL dashboard is directly routable as POL TVL and appears in navigation', async () => {
  const [appSource, trackerSource] = await Promise.all([
    readFile(new URL('../src/App.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/POLTracker.svelte', import.meta.url), 'utf8')
  ]);
  const visibleApps = appSource.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';

  assert.equal(visibleApps.includes('polTvlApp'), true);
  assert.match(appSource, /path: "pol-tvl"/);
  assert.match(appSource, /name: "POL TVL"/);
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
  assert.match(trackerSource, /<th>SYSTEM INCOME POL<\/th>/);
  assert.match(trackerSource, /pool\.reservePolUsd/);
  assert.match(trackerSource, /pool\.systemIncomePolUsd/);
  assert.match(trackerSource, /DRAG TO ZOOM · DOUBLE-CLICK RESET/);
  assert.match(trackerSource, /<TimeSeriesChart/);
  assert.match(trackerSource, /onHover=\{/);
  assert.match(trackerSource, /id="pol-tvl-day"/);
});

test('POL Tracker exposes the four consolidated public chart values', () => {
  const ids = POL_TRACKER_SERIES.map(({ id }) => id);
  assert.deepEqual(ids, ['synth', 'treasury_total', 'reserve_pol', 'system_income_pol']);
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
    current: {
      system_income_pol: {
        as_of: '2026-08-19T11:59:00.000Z',
        position_rune: 1291.16190955,
        position_usd: 620.68969015,
        rune_leg_usd: 310.26335531,
        asset_leg_usd: 310.42633484
      }
    },
    daily: [{
      day: '2025-02-01',
      height: 123,
      savers_usd: 20,
      synth: { backing_usd: 30 },
      treasury_lp: { asset_leg_usd: 4, rune_leg_usd: 5, total_usd: 9 },
      reserve_pol: { deployed_rune: 10, deployed_usd: 20 },
      system_income_pol: { position_rune: 12, position_usd: 24 },
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
      reserve_pol_usd: 20,
      system_income_pol_rune: 12,
      system_income_pol_usd: 24
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
  assert.equal(dashboard.latestPools[0].systemIncomePolRune, 12);
  assert.equal(dashboard.latestPools[0].systemIncomePolUsd, 24);
  assert.deepEqual(dashboard.currentSystemIncomePol, {
    asOf: '2026-08-19T11:59:00.000Z',
    positionRune: 1291.16190955,
    positionUsd: 620.68969015,
    runeLegUsd: 310.26335531,
    assetLegUsd: 310.42633484
  });
});

test('POL TVL headline prefers the current full System Income POL position while history stays daily', async () => {
  const trackerSource = await readFile(new URL('../src/lib/POLTracker.svelte', import.meta.url), 'utf8');
  assert.match(trackerSource, /currentSystemIncomePol\?\.positionUsd \?\? latest\?\.systemIncomePolUsd/);
  assert.match(trackerSource, /currentSystemIncomePol\?\.positionRune \?\? latest\?\.systemIncomePolRune/);
  assert.match(trackerSource, /FULL TWO-SIDED POSITION/);
});

test('the latest-pool table keeps pools whose only tracked value is either form of POL', () => {
  const pools = relevantPolTrackerPools([
    { asset: 'BTC.BTC', synthBackingUsd: 0, treasuryTotalUsd: 0, reservePolUsd: 20 },
    { asset: 'ETH.ETH', synthBackingUsd: 0, treasuryTotalUsd: 0, reservePolUsd: 0, systemIncomePolUsd: 15 },
    { asset: 'DOGE.DOGE', synthBackingUsd: 0, treasuryTotalUsd: 0, reservePolUsd: 0, systemIncomePolUsd: 0 }
  ]);
  assert.deepEqual(pools.map(({ asset }) => asset), ['BTC.BTC', 'ETH.ETH']);
});

test('the consolidated chart stacks four same-height values and totals their values', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    day: new Date(Date.UTC(2025, 2, index + 1)).toISOString().slice(0, 10),
    synthBackingUsd: index === 20 ? null : 10, treasuryTotalUsd: 20, reservePolUsd: 30, systemIncomePolUsd: 40
  }));
  const selected = selectPolTrackerRange(rows, '30d');
  assert.equal(selected.length, 30);
  const values = polTrackerStackValues(selected);
  assert.equal(values.length, 4);
  assert.ok(values.every(series => series[10] === null));
  assert.deepEqual(values.map(series => series[0]), [10, 20, 30, 40]);
  assert.equal(totalPolTrackerValue(rows[0]), 100);
  assert.equal(totalPolTrackerValue(rows[20]), null);
});

test('zero System Income POL does not draw an orange outline over other holdings', () => {
  const rows = [0, 0, 0].map((value, index) => ({ day: `2026-08-0${index + 1}`,
    synthBackingUsd: 100, treasuryTotalUsd: 20, reservePolUsd: 10, systemIncomePolUsd: value }));
  assert.deepEqual(polTrackerStackValues(rows)[3], [null, null, null]);
  assert.equal(totalPolTrackerValue(rows[0]), 130);
});

test('System Income POL series begins at positive holdings and breaks across zero or missing days', () => {
  const values = [0, 0, 5, 10, 0, 8, 9, null, 3, 4, 0];
  const rows = values.map((value, index) => ({
    day: `2026-08-${String(index + 1).padStart(2, '0')}`,
    synthBackingUsd: 100, treasuryTotalUsd: 20, reservePolUsd: 10, systemIncomePolUsd: value
  }));
  assert.deepEqual(polTrackerStackValues(rows)[3], values.map(value => value || null));
  assert.equal(totalPolTrackerValue(rows[2]), 135);
  assert.equal(totalPolTrackerValue(rows[7]), null);
});

test('a zero lower holding leaves positive upper stack layers available; missing or invalid lower values do not', () => {
  const rows = [0, null, -1].map((value, index) => Object.freeze({ day: `2026-08-0${index + 1}`,
    synthBackingUsd: value, treasuryTotalUsd: 20, reservePolUsd: 10, systemIncomePolUsd: 5
  }));
  assert.deepEqual(polTrackerStackValues(Object.freeze(rows)), [
    [null, null, null], [20, null, null], [10, null, null], [5, null, null]
  ]);
});
