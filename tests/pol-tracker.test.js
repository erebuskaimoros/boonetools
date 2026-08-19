import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  POL_TRACKER_SERIES,
  buildPolTrackerChart,
  normalizePolTrackerPayload,
  selectPolTrackerRange
} from '../src/lib/pol-tracker/model.js';

test('POL Tracker remains directly routable without appearing in navigation', async () => {
  const appSource = await readFile(new URL('../src/App.svelte', import.meta.url), 'utf8');
  const visibleApps = appSource.match(/const apps = \[([\s\S]*?)\n  \];/)?.[1] || '';

  assert.equal(visibleApps.includes('polTrackerApp'), false);
  assert.match(appSource, /const hiddenApps = \[wasmArbEconomicsApp, polTrackerApp\];/);
  assert.match(appSource, /return \[\.\.\.apps, \.\.\.hiddenApps\]\.find/);
});

test('POL Tracker exposes the Reserve-owned RUNEPool series but no provider series', () => {
  const ids = POL_TRACKER_SERIES.map(({ id }) => id);
  assert.ok(ids.includes('runepool_reserve'));
  assert.equal(ids.some((id) => id.includes('provider')), false);
});

test('POL Tracker normalization ignores provider-owned fields in transport payloads', () => {
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
    }]
  });
  assert.equal(dashboard.daily[0].runepoolReserveUsd, 12);
  assert.equal(Object.keys(dashboard.daily[0]).some((key) => key.includes('provider')), false);
});

test('range selection and chart paths preserve null daily gaps', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    day: `2025-03-${String(index + 1).padStart(2, '0')}`,
    saversUsd: index === 20 ? null : index + 1,
    synthBackingUsd: index + 2
  }));
  const selected = selectPolTrackerRange(rows, '30d');
  assert.equal(selected.length, 30);
  const chart = buildPolTrackerChart(selected, 'liabilities');
  const saversPath = chart.paths.find(({ id }) => id === 'savers').path;
  assert.ok((saversPath.match(/M/g) || []).length >= 2);
});
