import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePoolAnalysisSummary, selectPoolAnalysisPeriod, poolAnalysisPeriodDescription, poolAnalysisWindowLabel } from '../src/lib/pool-analysis/model.js';

test('selected Pool Analysis periods retain exact bounds and stale/incomplete state', () => {
  const payload = { pools: [{ asset: 'BTC.BTC', period_metrics: {
    '24h': { window_start: '2026-09-04T12:03:00Z', window_end: '2026-09-05T12:03:00Z', stale: true, incomplete: false, usd_fee_estimate: true, volume_usd: 123 },
    '30d': { window_start: '2026-08-06T12:03:00Z', window_end: '2026-09-05T12:03:00Z', stale: false, incomplete: true, volume_usd: null }
  } }] };
  const dashboard = normalizePoolAnalysisSummary(payload);
  const day = selectPoolAnalysisPeriod(dashboard.pools[0], '24h');
  assert.equal(day.windowStart, '2026-09-04T12:03:00Z');
  assert.equal(day.windowEnd, '2026-09-05T12:03:00Z');
  assert.equal(day.periodStale, true);
  assert.equal(day.periodIncomplete, false);
  assert.equal(day.usdFeeEstimate, true);
  assert.equal(dashboard.pools[0].periodIncomplete, true);
});


test('period descriptions distinguish exact rolling windows from completed-day legacy data', () => {
  assert.equal(poolAnalysisPeriodDescription({ mode: 'rolling' }, '24h'), 'the preceding 24 hours');
  assert.equal(poolAnalysisPeriodDescription({ mode: 'rolling' }, '7d'), 'the preceding 7 days');
  assert.equal(poolAnalysisPeriodDescription({ mode: 'rolling' }, '30d'), 'the preceding 30 days');
  assert.equal(poolAnalysisPeriodDescription({}, '24h'), 'the latest completed UTC day');
  assert.equal(poolAnalysisPeriodDescription({ through_day: '2026-09-04' }, '30d'), '30 completed UTC days');
});

test('quarter-hour periods distinguish retained daily history from ready rolling windows', () => {
  const dashboard = normalizePoolAnalysisSummary({ period: { mode: 'bucketed' }, pools: [{ asset: 'BTC.BTC', period_metrics: {
    '24h': { window_mode: 'rolling', snapshot_ready: true, snapshot_resolution_seconds: 900 },
    '30d': { window_mode: 'completed-days', snapshot_ready: false, snapshot_resolution_seconds: 900 }
  } }] });
  assert.equal(selectPoolAnalysisPeriod(dashboard.pools[0], '24h').snapshotReady, true);
  assert.equal(dashboard.pools[0].windowMode, 'completed-days');
  assert.equal(dashboard.pools[0].snapshotReady, false);
  assert.equal(dashboard.pools[0].snapshotResolutionSeconds, 900);
  assert.equal(poolAnalysisWindowLabel(selectPoolAnalysisPeriod(dashboard.pools[0], '24h'), dashboard.period), 'ROLLING · 15M');
  assert.equal(poolAnalysisWindowLabel(dashboard.pools[0], dashboard.period), 'DAILY · BUILDING HISTORY');
  assert.match(poolAnalysisPeriodDescription(dashboard.period, '30d'), /15-minute history/);
  assert.match(poolAnalysisPeriodDescription(dashboard.period, '30d'), /30 completed UTC days/);
});

test('Pool Analysis keeps snapshot status notes out of table cells', async () => {
  const source = await readFile(
    new URL('../src/lib/PoolAnalysis.svelte', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(source, /<small class="period-mode">/);
  assert.doesNotMatch(source, /<small class="period-cutoff">/);
});
