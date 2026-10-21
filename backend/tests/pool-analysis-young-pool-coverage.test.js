import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolAnalysisReadModel } from '../src/shared/pool-analysis.js';
import { normalizePoolAnalysisSummary, selectPoolAnalysisPeriod } from '../../src/lib/pool-analysis/model.js';

const NOW = '2026-10-21T08:32:00.000Z';
const START = '2026-10-02';
const asset = 'ZEC.ZEC';
const missingWarning = /incomplete 30-day history coverage/;
const amounts = { volume_rune_e8: '9007199254740993', volume_usd: '1000', fees_rune_e8: '900719925474099', fees_usd: '10' };

async function model({ firstDay = START, historyStart, observed = 19, aggregateFirst = START,
  lastDay = '2026-10-20', syncError = '', stale = false, includeAnchor = true,
  windowEnd = '2026-10-21T00:00:00.000Z', windowMode = 'completed-days', now = NOW,
  aggregateAmounts = amounts } = {}) {
  const periods = [{ id: '30d', days: 30 }, { id: '90d', days: 90 }, { id: '1y', days: 365 }];
  return buildPoolAnalysisReadModel({}, {
    now,
    getCoreSnapshot: async () => ({ sourceUpdatedAt: now, payload: {
      pools: [{ asset, status: 'Available', balance_rune: '100000000', balance_asset: '100000000' }],
      oracle_prices: { prices: [{ symbol: 'RUNE', price: '1' }] },
      field_meta: { pools: { status: 'fresh' }, oracle_prices: { status: 'fresh' } }
    } }),
    loadAggregates: async () => periods.map(({ id, days }) => ({
      asset, period_id: id, period_days: days, ...aggregateAmounts,
      first_day: aggregateFirst, last_day: lastDay, observed_days: observed,
      window_start: new Date(Date.parse(windowEnd) - days * 86400000).toISOString(),
      window_end: windowEnd, window_mode: windowMode, snapshot_ready: windowMode === 'rolling',
      incomplete: observed < days, stale
    })),
    loadSyncStates: async () => includeAnchor ? [{ asset, first_day: firstDay, history_start_day: historyStart, last_day: lastDay,
      last_error: syncError, updated_at: now }] : []
  });
}

test('new ZEC history is complete since its recorded start, not eleven missing pre-pool days', async () => {
  const result = await model();
  assert.doesNotMatch(result.payload.warnings.join(' '), missingWarning);
  assert.equal(result.stats.incomplete_pools, 0);
  const pool = result.payload.pools[0];
  for (const id of ['30d', '90d', '1y']) {
    const metric = pool.period_metrics[id];
    assert.equal(metric.incomplete, false, `${id} must not flag days before recorded pool history`);
    assert.equal(metric.coverage.expected_days, 19);
    assert.equal(metric.coverage.observed_days, 19);
    assert.equal(metric.coverage.missing_days, 0);
    assert.equal(metric.volume_rune_e8, amounts.volume_rune_e8);
    assert.equal(metric.fees_rune_e8, amounts.fees_rune_e8);
  }
  const selected = selectPoolAnalysisPeriod(normalizePoolAnalysisSummary(result.payload).pools[0], '30d');
  assert.equal(selected.periodIncomplete, false);
  assert.equal(selected.coverage.missingDays, 0, 'existing UI must no longer show a coverage warning');
  assert.equal(selected.coverage.expectedDays, 19);
});

test('young pools still warn about an internal missing day after their recorded start', async () => {
  const result = await model({ observed: 18 });
  const metric = result.payload.pools[0].period_metrics['30d'];
  assert.match(result.payload.warnings.join(' '), missingWarning);
  assert.equal(result.stats.incomplete_pools, 1);
  assert.equal(metric.incomplete, true);
  assert.equal(metric.coverage.expected_days, 19);
  assert.equal(metric.coverage.missing_days, 1);
});

test('missing leading or trailing days within known pool history cannot shrink the expected span', async () => {
  for (const changes of [{ observed: 18, aggregateFirst: '2026-10-03' }, { observed: 18, lastDay: '2026-10-19' }]) {
    const result = await model(changes);
    const metric = result.payload.pools[0].period_metrics['30d'];
    assert.match(result.payload.warnings.join(' '), missingWarning);
    assert.equal(metric.coverage.expected_days, 19);
    assert.equal(metric.coverage.missing_days, 1);
  }
});

test('established and unknown-age pools retain full-window gap warnings', async () => {
  for (const changes of [{ firstDay: '2021-04-01' }, { includeAnchor: false }, { firstDay: null },
    { firstDay: 'bad-date' }, { firstDay: '2026-10-22' }, { firstDay: '2026-02-31' }]) {
    const result = await model(changes);
    const metric = result.payload.pools[0].period_metrics['30d'];
    assert.match(result.payload.warnings.join(' '), missingWarning);
    assert.equal(metric.coverage.expected_days, 30);
    assert.equal(metric.coverage.missing_days, 11);
    assert.equal(metric.incomplete, true);
  }
});

test('short history never suppresses source staleness or sync failures', async () => {
  const result = await model({ syncError: 'Provider unavailable', stale: true });
  assert.match(result.payload.warnings.join(' '), /history sync.*error/);
  assert.match(result.payload.warnings.join(' '), /stale or unavailable/);
  assert.equal(result.payload.pools[0].period_metrics['30d'].stale, true);
});

test('PostgreSQL Date anchors and UTC midnight boundaries count completed days only', async () => {
  const result = await model({ firstDay: new Date('2026-10-02T00:00:00Z'), now: '2026-10-21T00:02:00Z' });
  const metric = result.payload.pools[0].period_metrics['30d'];
  assert.equal(metric.coverage.expected_days, 19);
  assert.equal(metric.coverage.missing_days, 0);
  assert.doesNotMatch(result.payload.warnings.join(' '), missingWarning);
});

test('earlier durable tracking start keeps initially failed collection days missing', async () => {
  const result = await model({ historyStart: '2026-10-01' });
  const metric = result.payload.pools[0].period_metrics['30d'];
  assert.equal(metric.coverage.expected_days, 20);
  assert.equal(metric.coverage.missing_days, 1);
  assert.match(result.payload.warnings.join(' '), missingWarning);
});

test('recent anchors cannot contradict older known observations or shorten exact rolling windows', async () => {
  for (const changes of [{ firstDay: '2026-10-05' }, { windowMode: 'rolling', windowEnd: '2026-10-21T08:30:00Z' }]) {
    const result = await model(changes);
    const metric = result.payload.pools[0].period_metrics['30d'];
    assert.equal(metric.coverage.expected_days, 30);
    assert.equal(metric.coverage.missing_days, 11);
    assert.match(result.payload.warnings.join(' '), missingWarning);
  }
});

test('a pool first tracked today has no expected completed days and no fabricated historical totals', async () => {
  const result = await model({ firstDay: '2026-10-21', observed: 0, aggregateFirst: null, lastDay: null,
    aggregateAmounts: { volume_rune_e8: null, volume_usd: null, fees_rune_e8: null, fees_usd: null } });
  const metric = result.payload.pools[0].period_metrics['30d'];
  assert.equal(metric.coverage.expected_days, 0);
  assert.equal(metric.coverage.missing_days, 0);
  assert.equal(metric.incomplete, false);
  assert.equal(metric.fees_rune_e8, null);
  assert.equal(metric.volume_rune_e8, null);
  assert.doesNotMatch(result.payload.warnings.join(' '), missingWarning);
});
