import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBurnTrackerOption } from '../src/lib/burn-tracker/charts.js';
import { buildSystemIncomePolDepositOption, buildSystemIncomePolFeeOption } from '../src/lib/system-income-pol/charts.js';
import { buildTimeSeriesOption } from '../src/lib/charts/time-series.js';
import { buildEventCalendarOption, eventCalendarDays } from '../src/lib/charts/event-calendar.js';
import { buildRapidSwapOverviewOption } from '../src/lib/rapid-swaps/overview-charts.js';
import { currencyConfig, getCurrencySymbol } from '../src/lib/stores/currency.js';
import { formatNumber } from '../src/lib/utils/formatting.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';

const days = Array.from({ length: 100 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  burnedRune: 12.5, cumulativeBurnedRune: (index + 1) * 12.5,
  burnedUsd: 25, cumulativeBurnedUsd: (index + 1) * 25, runePriceUsd: 2,
  depositedPlotRune: 12.5, depositedPlotValue: 12.5, cumulativeDepositedValue: (index + 1) * 12.5,
  value: 12.5, poolDeposits: [{ asset: 'XRP.XRP', rune: 12.5, value: 12.5 }]
}));
const hoverLast = option => option.tooltip.formatter([{ dataIndex: option._rows.length - 1 }]);

test('burn rolling averages retain RUNE denomination in day/week/month tooltips', () => {
  for (const grain of ['day', 'week', 'month']) {
    for (const period of [7, 30, 90]) {
      const html = hoverLast(buildBurnTrackerOption(days, { unit: 'rune',
        analysis: { grain, rolling: [`daily-${period}d`, `cumulative-${period}d`, `price-${period}d`] } }));
      assert.match(html, new RegExp(`${period}D AVG · DAILY BURN: [^<]*(?:RUNE|ᚱ)`));
      assert.match(html, new RegExp(`${period}D AVG · CUMULATIVE BURN: [^<]*(?:RUNE|ᚱ)`));
      assert.match(html, new RegExp(`${period}D AVG · RUNE / USD: \\$`));
      const usd = hoverLast(buildBurnTrackerOption(days, { unit: 'usd', analysis: { grain, rolling: [`daily-${period}d`] } }));
      assert.match(usd, new RegExp(`${period}D AVG · DAILY BURN: \\$`));
    }
  }
});

test('POL recipient and fee rolling averages retain selected currency in all bucket views', () => {
  for (const grain of ['day', 'week', 'month']) {
    for (const unit of ['rune', 'usd']) {
      for (const period of [7, 30, 90]) {
        const deposited = hoverLast(buildSystemIncomePolDepositOption(days, { unit,
          analysis: { grain, rolling: [`pool:XRP.XRP-${period}d`] } }));
        const fees = hoverLast(buildSystemIncomePolFeeOption(days, { unit,
          analysis: { grain, rolling: [`fees-${period}d`] } }));
        const amount = unit === 'usd' ? '$12.50' : '12.50 RUNE';
        assert.ok(deposited.includes(`${period}D AVG · XRP · XRP: ${amount}`));
        assert.ok(fees.includes(`${period}D AVG · DAILY EST. FEES: ${amount}`));
      }
    }
  }
});

test('analysis tooltips may use explicit units without changing compact axis ticks', () => {
  const option = buildTimeSeriesOption(days, {
    axes: [{ id: 'balance', format: value => String(value), tooltipFormat: value => `${value} RUNE` }],
    series: [{ id: 'balance', axis: 'balance', label: 'BALANCE', mark: 'line', data: days.map(() => 12.5) }],
    tooltip: row => row.day, analysis: { rolling: ['balance-7d'] }
  });
  assert.equal(option.yAxis[0].axisLabel.formatter(12.5), '12.5');
  assert.match(hoverLast(option), /7D AVG · BALANCE: 12.5 RUNE/);
});

test('Bond calendar and rolling tooltips retain RUNE and every selected currency without reconverting amounts', () => {
  const source = readFileSync(new URL('../src/lib/BondTrackerV2.svelte', import.meta.url), 'utf8');
  const assignment = parse(source).instance.content.body.find(statement =>
    statement.type === 'LabeledStatement' && statement.body.expression?.left?.name === 'calendarMetrics').body.expression;
  const metricsSource = source.slice(assignment.right.start, assignment.right.end);
  for (const [currency, config] of Object.entries(currencyConfig)) {
    const metrics = runInNewContext(metricsSource, { historySummaryCurrency: currency, currencyConfig, getCurrencySymbol, formatNumber });
    const amount = currency === 'BTC' ? 0.12345678 : 1234.567891;
    const events = days.map(row => ({ time: `${row.day}T12:00:00Z`, rune: 123.45, value: amount }));
    const rows = eventCalendarDays(events, metrics);
    const expected = `${config.symbol}${amount.toLocaleString('en-US', { minimumFractionDigits: config.preciseDecimals, maximumFractionDigits: config.preciseDecimals })}`;
    for (const grain of ['day', 'week', 'month']) {
      const option = buildEventCalendarOption(rows, { metrics, analysis: { grain,
        rolling: ['rune-7d', 'value-7d', 'value-30d', 'value-90d'] } });
      const html = hoverLast(option);
      assert.match(html, /7D AVG · RUNE STACK: 123.45 RUNE/);
      for (const period of [7, 30, 90]) assert.ok(html.includes(`${period}D AVG · ${currency} VALUE: ${expected}`), html);
      assert.equal(option.yAxis[1].axisLabel.formatter(amount), amount.toLocaleString('en-US', { maximumFractionDigits: 3 }), 'hover precision must not change axis tick format');
    }
    assert.ok(hoverLast(buildEventCalendarOption(rows, { metrics })).includes(`${currency} VALUE: ${expected}`));
  }
});

test('Rapid Swaps count rolling means retain fractional swaps and efficiency has a multiplier unit', () => {
  const rows = days.map((row, index) => ({ ...row, count: index % 2 ? 10 : 11, cumCount: 100 + index, efficiency: 1.234 }));
  for (const grain of ['day', 'week', 'month']) {
    for (const period of [7, 30, 90]) {
      const counts = buildRapidSwapOverviewOption(rows, { metric: 'count', analysis: { grain, rolling: [`count-${period}d`, `cumCount-${period}d`] } });
      assert.match(hoverLast(counts), new RegExp(`${period}D AVG · COUNT: 10\\.(?:429|5) swaps`));
      assert.match(hoverLast(counts), new RegExp(`${period}D AVG · CUMULATIVE: [^<]* swaps`));
      assert.equal(counts.yAxis[0].axisLabel.formatter(10.5), '11');
      const efficiency = buildRapidSwapOverviewOption(rows, { metric: 'efficiency', analysis: { grain, rolling: [`efficiency-${period}d`] } });
      assert.match(hoverLast(efficiency), new RegExp(`${period}D AVG · EFFICIENCY: 1.23×`));
      assert.equal(efficiency.yAxis[0].axisLabel.formatter(1.234), '1.23');
    }
  }
});

test('missing rolling windows remain unavailable without applying a denomination to null values', () => {
  const incomplete = days.map((row, index) => index === days.length - 1 ? { ...row, value: null } : row);
  for (const grain of ['day', 'week', 'month']) {
    const html = hoverLast(buildSystemIncomePolFeeOption(incomplete, { unit: 'usd',
      analysis: { grain, rolling: ['fees-7d', 'fees-30d', 'fees-90d'] } }));
    for (const period of [7, 30, 90]) assert.match(html, new RegExp(`${period}D AVG · DAILY EST. FEES: unavailable`));
    assert.doesNotMatch(html, /\$unavailable|NaN/);
  }
});
