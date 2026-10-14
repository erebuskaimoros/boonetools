import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, contribution, monthlyComparison } from '../shared/protocol-fee-comparison/model.js';
import { buildComparisonTimeSeries } from '../src/lib/protocol-fee-comparison/time-series.js';

const daily = calendarDays('2026-08-01', '2026-09-18').map(day => ({ day,
  thorchain: contribution(100, 1), near: contribution(20, 200), chainflip: contribution(15, 10)
}));

// Exercise the same analysis path as TimeSeriesChart, not just the adapter's
// ungrouped tooltip: the production chart offers all available calendar grains.
function chartWithTools(rows, grain, options = {}) {
  const settings = { nearNetSupply: true, ...options };
  const baseSpec = buildComparisonTimeSeries(rows, { ...settings, hidden: [] })._spec;
  return buildComparisonTimeSeries(rows, { ...settings,
    analysis: { grain, hidden: settings.hidden || [], rolling: settings.rolling || [], baseSpec }
  });
}

test('monthly comparison tooltip retains fees and supply/subsidy breakdown for every protocol', () => {
  const chart = chartWithTools(daily, 'month');
  const tooltip = chart.tooltip.formatter([{ dataIndex: 0 }]);
  assert.equal((tooltip.match(/Fees collected:/g) || []).length, 3);
  assert.match(tooltip, /Fees collected: \$3,100/);
  assert.match(tooltip, /Fees collected: \$620/);
  assert.match(tooltip, /Fees collected: \$465/);
  assert.match(tooltip, /Net token supply change: \$6,200/);
  assert.match(tooltip, /Midgard earnings residual \(legacy\): \$31/);
  assert.match(tooltip, /Token subsidy \(gross issuance\): \$310/);
  assert.match(tooltip, /After subsidy: -\$5,580/);
  assert.equal((tooltip.match(/data-series=/g) || []).length, 3);
  assert.match(tooltip, /including all protocol burns/);
  assert.doesNotMatch(tooltip, /Own frontend|Other retained income/);
  assert.equal(chart.series.find(item => item.id === 'near').data[0], -5580);
});

test('weekly details sum only the bucket dates and retain partial coverage', () => {
  const chart = chartWithTools(daily, 'week');
  const tooltip = chart.tooltip.formatter([{ dataIndex: chart._rows.length - 1 }]);
  assert.match(tooltip, /2026-09-14.*2026-09-17/);
  assert.match(tooltip, /PARTIAL/);
  assert.match(tooltip, /Fees collected: \$400/);
  assert.match(tooltip, /Fees collected: \$80/);
  assert.match(tooltip, /Net token supply change: \$800/);
  assert.match(tooltip, /After subsidy: -\$720/);
});

test('hidden protocols stay out of grouped details while rolling overlays remain labeled', () => {
  const chart = chartWithTools(daily, 'month', { hidden: ['near'], rolling: ['thorchain-7d'] });
  const tooltip = chart.tooltip.formatter([{ dataIndex: 0 }]);
  assert.doesNotMatch(tooltip, /data-series="near"|NEAR Intents|Net token supply change:/);
  assert.equal((tooltip.match(/Fees collected:/g) || []).length, 2);
  assert.match(tooltip, /7D AVG.*THORChain/);
  assert.match(tooltip, /\$99/);
});

test('daily tooltips retain signed net supply changes and monthly missing data stays unavailable', () => {
  const rows = structuredClone(daily);
  rows[0].near = contribution(20, -200);
  const dayTooltip = chartWithTools(rows, 'day').tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(dayTooltip, /Fees collected: \$20/);
  assert.match(dayTooltip, /Net token supply change: -\$200/);
  assert.match(dayTooltip, /After subsidy: \$220/);
  rows[1].near = contribution(null, null);
  const monthly = chartWithTools(rows, 'month');
  assert.equal(monthly.series.find(item => item.id === 'near').data[0], null);
  const tooltip = monthly.tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(tooltip, /Unavailable/);
  assert.doesNotMatch(tooltip, /Net token supply change: \$0|After subsidy: \$0/);
  assert.match(tooltip, /Fees collected: \$3,100/);
});

test('daily reward details show sub-dollar emissions and escape signed sub-cent bounds', () => {
  const rows = [{ ...daily[0],
    thorchain: { ...contribution(100, 0.4658597059627627), grossIncomeUsd: 105, revshareUsd: 5 },
    near: contribution(20, -0.00004822)
  }];
  let tooltip = chartWithTools(rows, 'day', { thorchainRewardAccounting: true }).tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(tooltip, /Reserve emissions: \$0\.47/);
  assert.match(tooltip, /Net token supply change: &gt;-\$0\.01/);
  rows[0].thorchain = { ...rows[0].thorchain, ...contribution(100, 0.00004822) };
  tooltip = chartWithTools(rows, 'day', { thorchainRewardAccounting: true }).tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(tooltip, /Reserve emissions: &lt;\$0\.01/);
  assert.doesNotMatch(tooltip, /Reserve emissions: \$0(?:<|\.)/);
});

test('legacy monthly snapshots keep the breakdown without calling gross NEAR issuance net supply', () => {
  const months = monthlyComparison(daily, { now: Date.parse('2026-09-18T12:00:00Z'), startDay: '2026-08-01', endDay: '2026-09-18' });
  const rows = months.map(row => ({ ...row, day: row.fromDay }));
  const tooltip = chartWithTools(rows, 'month', { sourceGrain: 'month', nearNetSupply: false }).tooltip.formatter([{ dataIndex: 0 }]);
  assert.equal((tooltip.match(/Fees collected:/g) || []).length, 3);
  assert.doesNotMatch(tooltip, /Net token supply change:/);
  assert.match(tooltip, /Token subsidy \(gross issuance\): \$6,200/);
});

test('an interior missing day does not become a smaller but apparently complete monthly total', () => {
  const rows = daily.filter(row => row.day !== '2026-08-15');
  const chart = chartWithTools(rows, 'month');
  assert.ok(chart.series.every(item => item.data[0] === null));
  const tooltip = chart.tooltip.formatter([{ dataIndex: 0 }]);
  assert.equal((tooltip.match(/Unavailable/g) || []).length, 3);
  assert.doesNotMatch(tooltip, /Fees collected: \$|After subsidy: \$/);
});

test('corrected THORChain tooltip separates gross fees, REVSHARE, retained income and Reserve emissions in every grain', () => {
  const rows = daily.map(row => ({ ...row,
    thorchain: { ...contribution(95, 1), grossIncomeUsd: 100, revshareUsd: 5 }
  }));
  for (const grain of ['day', 'week', 'month']) {
    const chart = chartWithTools(rows, grain, { thorchainRewardAccounting: true });
    const tooltip = chart.tooltip.formatter([{ dataIndex: 0 }]);
    const count = grain === 'day' ? 1 : grain === 'week' ? 2 : 31;
    assert.match(tooltip, new RegExp(`Gross liquidity fees: \\$${(count * 100).toLocaleString('en-US')}`));
    assert.match(tooltip, new RegExp(`REVSHARE paid: \\$${count * 5}`));
    assert.match(tooltip, new RegExp(`Retained fees: \\$${(count * 95).toLocaleString('en-US')}`));
    assert.match(tooltip, new RegExp(`Reserve emissions: \\$${count}`));
    assert.match(tooltip, new RegExp(`After subsidy: \\$${(count * 94).toLocaleString('en-US')}`));
    assert.doesNotMatch(tooltip, /Reserve rewards|Midgard residual/);
  }
});

test('corrected TC tooltips preserve observed fees and REVSHARE while Reserve emissions are unavailable', () => {
  const rows = daily.map(row => ({ ...row,
    thorchain: { ...contribution(95, null), grossIncomeUsd: 100, revshareUsd: 5 }
  }));
  const chart = chartWithTools(rows, 'month', { thorchainRewardAccounting: true });
  const tooltip = chart.tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(tooltip, /Gross liquidity fees: \$3,100/);
  assert.match(tooltip, /REVSHARE paid: \$155/);
  assert.match(tooltip, /Retained fees: \$2,945/);
  assert.match(tooltip, /Reserve emissions: Unavailable/);
  assert.match(tooltip, /After subsidy: Unavailable/);
  assert.match(tooltip, /0\/31 days covered/);
  assert.equal(chart.series.find(item => item.id === 'thorchain').data[0], null);
  assert.equal(chart.series.find(item => item.id === 'near').data[0], -5580);
});
