import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinancialEChartsOption } from '../src/lib/financials/echarts-options.js';
import { buildPoolAnalysisOption } from '../src/lib/pool-analysis/charts.js';
import { buildPolTrackerOption } from '../src/lib/pol-tracker/charts.js';
import { APP_LAYER_CHARTS, prepareAppLayerChart, buildAppLayerOption } from '../src/lib/app-layer/charts.js';
import { buildComparisonTimeSeries } from '../src/lib/protocol-fee-comparison/time-series.js';
import { PROTOCOLS } from '../shared/protocol-fee-comparison/model.js';

const rows = Array.from({ length: 100 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  volumeUsd: 120, incomeUsd: 12, volumeRune: 60, incomeRune: 6, bondingApr: 5,
  feesRune: 4, blockRewardsRune: 2, bondingEarningsRune: 2, activeBondRune: 100,
  feesUsd: 12, cumulativeFeesUsd: 100 + index, depthUsd: 1000, feesRuneBase: 400000000, volumeRuneBase: 6000000000,
  synthBackingUsd: 100, treasuryTotalUsd: 20, reservePolUsd: 10, systemIncomePolUsd: 5,
  ...Object.fromEntries(PROTOCOLS.map(({ id }) => [id, { incomeUsd: 20, subsidyUsd: 5, netUsd: 15 }]))
}));

function assertRollingUnits(builder, points, options, expected) {
  const base = builder(points, options)._spec;
  const series = base.series.filter(item => item.rolling !== false && item.legend !== false && !item.visibilityId);
  for (const grain of ['day', 'week', 'month']) {
    const rolling = series.flatMap(item => [7, 30, 90].map(days => `${item.id}-${days}d`));
    const option = builder(points, { ...options, analysis: { grain, rolling } });
    const html = option.tooltip.formatter([{ dataIndex: option._rows.length - 1 }]);
    const lines = html.split('<br>').filter(line => /\d+D AVG · /.test(line));
    assert.equal(lines.length, rolling.length, `${grain} includes all rolling metrics`);
    for (const line of lines) {
      assert.doesNotMatch(line, /unavailable|NaN|undefined/i);
      assert.match(line, expected(line), `${grain}: ${line}`);
    }
  }
}

test('Financials rolling overlays keep both currency modes and percent APR', () => {
  for (const currency of ['usd', 'rune']) assertRollingUnits(buildFinancialEChartsOption, rows, { currency }, line =>
    line.includes('BONDING APR') ? /: [^<]*%/ : currency === 'usd' ? /: \$/ : /: [^<]*ᚱ/);
});

test('Pool Analysis, POL TVL and Cross-chain Competitors rolling values remain dollar-denominated', () => {
  for (const builder of [buildPoolAnalysisOption, buildPolTrackerOption, buildComparisonTimeSeries]) {
    assertRollingUnits(builder, rows, {}, () => /: \$/);
  }
});

test('all App Layer chart modes keep dollars for every rolling overlay', () => {
  const raw = rows.map(row => ({ bucket_start: row.day, accrued_value_usd: 20, inflow_usd: 10,
    liquidity_fee_usd: 10, payment_usd: 20, pol_accrued_usd: 20,
    cumulative_usd: 100, cumulative_pol_accrued_usd: 100 }));
  for (const key of Object.keys(APP_LAYER_CHARTS)) {
    const points = prepareAppLayerChart({ rows: raw, grain: 'daily' }, key);
    for (const view of ['bars', 'cumulative']) assertRollingUnits(buildAppLayerOption, points, { key, view }, () => /: \$/);
  }
});
