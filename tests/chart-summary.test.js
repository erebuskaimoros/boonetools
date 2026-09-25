import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMetric, buildSummaryCards, selectSummaryRows, selectIndexSummaryRows, formatSummaryValue } from '../src/lib/charts/summary.js';
import { readFile } from 'node:fs/promises';
import { appLayerSummaryMetrics, prepareAppLayerChart } from '../src/lib/app-layer/charts.js';
import { buildSystemIncomePolChart, buildSystemIncomePolFeeChart } from '../src/lib/system-income-pol/model.js';
import { POL_TRACKER_SERIES } from '../src/lib/pol-tracker/model.js';

test('summary uses inclusive selected buckets, without mutating the source', () => {
  const rows = [{ day: '2026-09-01' }, { day: '2026-09-02' }, { day: '2026-09-03' }];
  assert.deepEqual(selectSummaryRows(rows, { startDay: '2026-09-02', endDay: '2026-09-03' }), rows.slice(1));
  assert.equal(rows.length, 3);
});

test('missing values are not zero; observed zero and signed values count', () => {
  const metric = { field: 'value', label: 'Income', kind: 'flow' };
  assert.deepEqual(summarizeMetric([{ value: null }, {}, { value: NaN }], metric), { count: 0, total: null, average: null, minimum: null, maximum: null, latest: null });
  assert.deepEqual(summarizeMetric([{ value: 0 }, { value: -5 }, { value: 15 }, { value: null }], metric), { count: 3, total: 10, average: 10 / 3, minimum: -5, maximum: 15, latest: null });
});

test('two flow metrics yield exactly four cards with bucket means and coverage', () => {
  const rows = [{ volume: 10, fees: 1 }, { volume: 0, fees: null, partial: true }];
  const cards = buildSummaryCards(rows, [{ field: 'volume', label: 'Volume', kind: 'flow' }, { field: 'fees', label: 'Fees', kind: 'flow' }], 'day');
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map(card => card.value), [10, 5, 1, 1]);
  assert.equal(cards[2].label, 'Observed fees total');
  assert.match(cards[3].detail, /1\/2/);
});

test('single-metric charts can show only total and average while preserving default cards elsewhere', () => {
  const metric = { field: 'depositedPlotValue', label: 'Deposits', kind: 'flow', unit: 'RUNE' };
  const rows = [{ day: '2026-09-01', depositedPlotValue: 100 }, { day: '2026-09-02', depositedPlotValue: 20, partial: true }, { day: '2026-09-03', depositedPlotValue: null }];
  const cards = buildSummaryCards(rows, [{ ...metric, statistics: ['total', 'average'] }], 'day');
  assert.deepEqual(cards.map(card => card.label), ['Observed deposits total', 'Avg deposits / day']);
  assert.deepEqual(cards.map(card => card.value), [120, 60]);
  assert.ok(cards.every(card => card.unit === 'RUNE' && card.detail.startsWith('2/3 day observations')));
  assert.equal(buildSummaryCards(rows, [metric], 'day').length, 4);
  const selected = selectSummaryRows(rows, { startDay: '2026-09-02', endDay: '2026-09-02' });
  assert.deepEqual(buildSummaryCards(selected, [{ ...metric, statistics: ['total', 'average'], unit: 'usd' }]).map(card => card.value), [20, 20]);
});

test('level/rate metrics never sum observations; latest does not carry forward missing data', () => {
  const cards = buildSummaryCards([{ balance: 10 }, { balance: 20 }, { balance: null }], [{ field: 'balance', label: 'Balance', kind: 'level' }]);
  assert.deepEqual(cards.map(card => card.value), [15, 10, 20, null]);
  assert.ok(cards.every(card => !card.label.includes('total')));
});

test('Financials can explicitly keep completed-day means while totals include partial days', () => {
  const metric = { field: 'value', label: 'Income', kind: 'flow', averageFilter: row => !row.partial, averageBasis: 'completed day' };
  const cards = buildSummaryCards([{ value: 100 }, { value: 20, partial: true }], [metric]);
  assert.equal(cards[0].value, 120);
  assert.equal(cards[1].value, 100);
  assert.match(cards[1].detail, /1\/1 completed day/);
  assert.equal(buildSummaryCards([{ value: 20, partial: true }], [metric])[1].value, null);
});

test('three/four metrics retain all series, with secondary means/latest and four cards', () => {
  for (const count of [3, 4]) {
    const metrics = Array.from({ length: count }, (_, i) => ({ label: `Protocol ${i}`, value: row => row.value, kind: 'flow' }));
    const cards = buildSummaryCards([{ value: 4 }, { value: 6 }], metrics, 'month');
    assert.equal(cards.length, 4);
    assert.equal(cards[0].value, 10);
    assert.equal(cards[0].secondary.value, 5);
  }
});

test('formatting is explicit about units and unavailable values', () => {
  assert.equal(formatSummaryValue(null, 'usd'), '—');
  assert.equal(formatSummaryValue(0, 'usd'), '$0');
  assert.equal(formatSummaryValue(-1000, 'usd'), '-$1K');
  assert.match(formatSummaryValue(2.5, 'bps'), /2.5 bps/);
  assert.equal(formatSummaryValue(0.00000123, 'BTC'), '0.00000123 BTC');
});

test('legacy category zoom uses visible bucket centers and reset restores all', () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(selectIndexSummaryRows(rows, { start: 0.2, end: 3.8 }), [2, 3, 4]);
  assert.deepEqual(selectIndexSummaryRows(rows, { start: -3, end: 10 }), rows);
  assert.deepEqual(selectIndexSummaryRows(rows, { start: 10, end: 12 }), []);
  assert.deepEqual(selectIndexSummaryRows(rows, { start: NaN, end: 3 }), []);
  assert.equal(selectIndexSummaryRows(rows, null), rows);
});

test('refresh and UTC window retirement follow the same bounds as the plot', () => {
  const rows = [{ day: '2026-09-01', value: 1 }, { day: '2026-09-02', value: 2 }];
  const window = { startDay: '2026-09-01', endDay: '2026-09-02' };
  const appended = [...rows, { day: '2026-09-03', value: 10 }];
  assert.deepEqual(selectSummaryRows(appended, window), rows);
  assert.deepEqual(selectSummaryRows(appended.slice(1), window), [rows[1]]);
  assert.deepEqual(selectSummaryRows(appended.slice(2), window), appended.slice(2));
});

test('App Layer summaries use periodic signed components and feature-owned zero fill, not cumulative anchors', () => {
  for (const grain of ['daily', 'weekly']) {
    const input = [
      { bucket_start: '2026-09-01', inflow_usd: -2, liquidity_fee_usd: 3, accrued_value_usd: 1, cumulative_usd: 1000 },
      { bucket_start: grain === 'weekly' ? '2026-09-15' : '2026-09-03', inflow_usd: 8, liquidity_fee_usd: 7, accrued_value_usd: 15, cumulative_usd: 1015 }
    ];
    const rows = prepareAppLayerChart({ rows: input, grain }, 'accrued');
    const cards = buildSummaryCards(rows, appLayerSummaryMetrics('accrued'), grain === 'weekly' ? 'week' : 'day');
    assert.deepEqual(cards.map(card => card.value), [6, 2, 10, 10 / 3]);
    assert.equal(rows[1].filledBucket, true);
  }
  for (const key of ['collected', 'paid', 'pol', 'generated']) {
    assert.equal(buildSummaryCards([], appLayerSummaryMetrics(key)).length, 4);
  }
});

test('POL deposits and fees respect unit changes, known zero, and unavailable prices', () => {
  const rows = [
    { day: '2026-09-01', deployedRune: 2, deployedUsd: 4, cumulativeDeployedRune: 100, estimatedFeesRune: 1, estimatedFeesUsd: 2 },
    { day: '2026-09-02', deployedRune: 3, deployedUsd: null, cumulativeDeployedRune: 103, estimatedFeesRune: 2, estimatedFeesUsd: null },
    { day: '2026-09-03', deployedRune: 0, deployedUsd: 0, cumulativeDeployedRune: 103, estimatedFeesRune: 0, estimatedFeesUsd: 0, partial: true }
  ];
  for (const unit of ['usd', 'rune']) {
    const deposits = summarizeMetric(buildSystemIncomePolChart(rows, { unit }).points, { field: 'depositedPlotValue' });
    const fees = summarizeMetric(buildSystemIncomePolFeeChart(rows, { unit }).points, { field: 'value' });
    assert.equal(deposits.total, unit === 'usd' ? 4 : 5);
    assert.equal(fees.total, unit === 'usd' ? 2 : 3);
    assert.equal(deposits.count, unit === 'usd' ? 2 : 3);
    assert.equal(fees.count, unit === 'usd' ? 2 : 3);
  }
});

test('POL TVL summarizes each stock independently without summing dollars across days', () => {
  const rows = [
    { synthBackingUsd: 10, treasuryTotalUsd: 20, reservePolUsd: 30, systemIncomePolUsd: 40 },
    { synthBackingUsd: 20, treasuryTotalUsd: null, reservePolUsd: 40, systemIncomePolUsd: 0 }
  ];
  const cards = buildSummaryCards(rows, POL_TRACKER_SERIES.map(metric => ({ ...metric, kind: 'level', unit: 'usd' })));
  assert.deepEqual(cards.map(card => card.value), [15, 20, 35, 20]);
  assert.deepEqual(cards.map(card => card.secondary.value), [20, null, 40, 0]);
});

test('primary time-series summaries retain chart-specific opt-outs, including legacy renderers', async () => {
  const configurations = {
    'PoolAnalysis.svelte': 1, 'BurnTracker.svelte': 1, 'SystemIncomePOL.svelte': 1,
    'POLTracker.svelte': 0, 'financials/Chart.svelte': 0,
    'system-income-pol/DailyFeeChart.svelte': 1, 'rapid-swaps/OverviewChart.svelte': 0,
    'app-layer/Chart.svelte': 1, 'protocol-fee-comparison/Chart.svelte': 1,
    'TCFeeDash.svelte': 2, 'WasmArbEconomics.svelte': 5, 'PoolDislocation.svelte': 1,
    'BondTrackerV2.svelte': 1, 'DynamicFeeDashboard.svelte': 2, 'status/BlockProductionChart.svelte': 1
  };
  for (const [file, count] of Object.entries(configurations)) {
    const source = await readFile(new URL(`../src/lib/${file}`, import.meta.url), 'utf8');
    assert.equal((source.match(/<RangeSummary\b/g) || []).length, count, file);
  }
  const rapid = await readFile(new URL('../src/lib/rapid-swaps/OverviewChart.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(rapid, /RangeSummary/);
  assert.match(rapid, /<TimeSeriesChart/);
  const rapidPage = await readFile(new URL('../src/lib/RapidSwaps.svelte', import.meta.url), 'utf8');
  assert.equal((rapidPage.match(/<OverviewChart\b/g) || []).length, 6);
  const pol = await readFile(new URL('../src/lib/POLTracker.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(pol, /RangeSummary/);
  assert.match(pol, /<TimeSeriesChart/);
  assert.match(pol, /aria-label="Latest POL TVL values"/);
  assert.match(pol, /INSPECT UTC DAY/);
  const financials = await readFile(new URL('../src/lib/financials/Chart.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(financials, /RangeSummary/);
  assert.match(financials, /<TimeSeriesChart/);
  const deposits = await readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8');
  assert.match(deposits, /<RangeSummary[^>]*statistics: \['total', 'average'\]/);
  const dynamic = await readFile(new URL('../src/lib/DynamicFeeDashboard.svelte', import.meta.url), 'utf8');
  assert.match(dynamic, /affiliateSummaryRange = \{ start: chart.scales.x.min, end: chart.scales.x.max \}/);
  assert.match(dynamic, /function resetAffiliateChartZoom\(\)[\s\S]*?affiliateSummaryRange = null/);
  const monthly = await readFile(new URL('../src/lib/protocol-fee-comparison/Chart.svelte', import.meta.url), 'utf8');
  assert.match(monthly, /complete \? row.protocols\[protocol.id\].netUsd : null/);
  const block = await readFile(new URL('../src/lib/status/BlockProductionChart.svelte', import.meta.url), 'utf8');
  assert.match(block, /value: totalBlocks \? weightedAverage : null/);
});
