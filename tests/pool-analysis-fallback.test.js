import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePoolAnalysisSummary, selectPoolAnalysisPeriod, poolAnalysisWindowLabel, poolAnalysisActivityStatus } from '../src/lib/pool-analysis/model.js';

test('a 24H daily substitution is explicitly labelled as a fallback', () => {
  const summary = normalizePoolAnalysisSummary({ period: { mode: 'bucketed' }, pools: [{
    asset: 'ZEC.ZEC', period_metrics: { '24h': {
      window_mode: 'completed-days', snapshot_ready: false,
      window_start: '2026-10-27T00:00:00Z', window_end: '2026-10-28T00:00:00Z',
      fees_usd: 438.73, coverage: { observed_days: 1, expected_days: 1, missing_days: 0 }
    } }
  }] });
  const row = selectPoolAnalysisPeriod(summary.pools[0], '24h');
  assert.match(poolAnalysisWindowLabel(row, summary.period), /FALLBACK/);
  assert.match(poolAnalysisWindowLabel(row, summary.period), /COMPLETED DAY/);
  assert.equal(row.windowEnd, '2026-10-28T00:00:00Z');
  assert.equal(poolAnalysisActivityStatus(row, summary.period), 'FALLBACK');
});

test('fallback notices require observed fee totals, including legitimate zero fees', () => {
  const period = { mode: 'bucketed' };
  const fallback = { windowMode: 'completed-days', snapshotReady: false, periodFeesUsd: 0 };
  assert.equal(poolAnalysisActivityStatus(fallback, period), 'FALLBACK');
  assert.equal(poolAnalysisActivityStatus({ ...fallback, periodFeesUsd: null }, period), 'UNAVAILABLE');
  assert.equal(poolAnalysisActivityStatus({ ...fallback, periodFeesUsd: undefined }, period), 'UNAVAILABLE');
});

test('rolling stale and incomplete data are distinct from a completed-day fallback', () => {
  const period = { mode: 'bucketed' };
  const rolling = { windowMode: 'rolling', snapshotReady: true, periodFeesUsd: 1025.36 };
  assert.equal(poolAnalysisActivityStatus(rolling, period), '');
  assert.equal(poolAnalysisActivityStatus({ ...rolling, periodStale: true }, period), 'STALE');
  assert.equal(poolAnalysisActivityStatus({ ...rolling, periodIncomplete: true }, period), 'INCOMPLETE');
  assert.equal(poolAnalysisActivityStatus({ ...rolling, periodIncomplete: true, periodFeesUsd: null }, period), 'UNAVAILABLE');
  assert.equal(poolAnalysisActivityStatus({ ...rolling, coverage: { missingDays: 1 } }, period), 'INCOMPLETE');
  assert.equal(poolAnalysisActivityStatus({ windowMode: 'completed-days', periodFeesUsd: 42 }, {}), '',
    'Legacy daily-only views are not described as degraded rolling windows');
});
