import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applyBurnTrackerHeadPayload,
  BURN_TRACKER_RANGES,
  formatBurnTrackerRate,
  formatBurnTrackerRuneBase,
  normalizeBurnTrackerPayload,
  selectBurnTrackerRange
} from '../src/lib/burn-tracker/model.js';

test('Burn Tracker is directly routable and visible in navigation', async () => {
  const [appSource, trackerSource] = await Promise.all([
    readFile(new URL('../src/App.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/BurnTracker.svelte', import.meta.url), 'utf8')
  ]);
  const visibleApps = appSource.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';
  assert.match(appSource, /path: "burn-tracker"/);
  assert.equal(visibleApps.includes('burnTrackerApp'), true);
  assert.match(appSource, /const hiddenApps = \[wasmArbEconomicsApp\];/);
  assert.match(trackerSource, />SYSTEM INCOME BURNED</);
  assert.match(trackerSource, />CURRENT RUNE SUPPLY</);
  assert.match(trackerSource, />CURRENT BURN RATE</);
  assert.match(trackerSource, /RUNE PRICE/);
  assert.match(trackerSource, /DRAG TO ZOOM/);
  assert.match(trackerSource, /LIVE PARTIAL/);
  assert.match(trackerSource, /subscribeChainHeads/);
  assert.match(trackerSource, /PER-BLOCK REWARDS/);
});

test('Burn Tracker exposes 30, 90, 180 day, and all-time presets with 90 days as the default selector', () => {
  assert.deepEqual(BURN_TRACKER_RANGES, [
    { id: '30d', label: '30D', days: 30 },
    { id: '90d', label: '90D', days: 90 },
    { id: '180d', label: '180D', days: 180 },
    { id: 'all', label: 'ALL TIME', days: null }
  ]);
  const rows = Array.from({ length: 200 }, (_, index) => ({ day: String(index) }));
  assert.equal(selectBurnTrackerRange(rows).length, 90);
  assert.equal(selectBurnTrackerRange(rows, '30d').length, 30);
  assert.equal(selectBurnTrackerRange(rows, '180d').length, 180);
  assert.equal(selectBurnTrackerRange(rows, 'all').length, 200);
});

test('Burn Tracker normalization preserves missing gaps, partial days, and all-time cumulative values', () => {
  const dashboard = normalizeBurnTrackerPayload({
    summary: {
      total_burned_e8: '201111243896490',
      current_supply_e8: '35402165993252075',
      burn_rate_bps: 500,
      burn_rate_percent: 5
    },
    daily: [
      { day: '2024-09-26', burn_e8: '100000000', cumulative_burn_e8: '100000000', rune_price_usd: '4' },
      { day: '2024-09-27', burn_e8: null, cumulative_burn_e8: null, rune_price_usd: null },
      { day: '2024-09-28', burn_e8: '50000000', cumulative_burn_e8: null, rune_price_usd: '4.2', partial: true }
    ]
  });
  assert.equal(dashboard.totalBurnedBase, '201111243896490');
  assert.equal(dashboard.currentSupplyBase, '35402165993252075');
  assert.equal(dashboard.daily[0].burnedRune, 1);
  assert.equal(dashboard.daily[1].burnedRune, null);
  assert.equal(dashboard.daily[2].partial, true);
  assert.equal(dashboard.daily[2].cumulativeBurnedRune, null);
  assert.equal(formatBurnTrackerRate(dashboard.burnRatePercent), '5.00%');
  assert.equal(formatBurnTrackerRuneBase('100000000'), '1.00');
});

test('Burn Tracker applies each streamed block once and advances its live height', () => {
  const initial = {
    as_of: '2026-08-23T12:00:00Z',
    summary: { total_burned_e8: '100', current_supply_e8: '1000' },
    daily: [{
      day: '2026-08-23',
      burn_e8: '100',
      cumulative_burn_e8: '100',
      partial: true
    }],
    live: { per_block: true, through_height: 9, through_time: '2026-08-23T12:00:00Z' }
  };
  const next = applyBurnTrackerHeadPayload(initial, {
    height: 10,
    time: '2026-08-23T12:00:06Z',
    income_burn_e8: '7'
  });
  assert.equal(next.summary.total_burned_e8, '107');
  assert.equal(next.summary.current_supply_e8, '993');
  assert.equal(next.daily[0].burn_e8, '107');
  assert.equal(next.live.through_height, 10);
  assert.equal(applyBurnTrackerHeadPayload(next, {
    height: 10,
    time: '2026-08-23T12:00:06Z',
    income_burn_e8: '7'
  }), next);
});
