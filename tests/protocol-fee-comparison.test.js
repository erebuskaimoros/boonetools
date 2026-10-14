import test from 'node:test';
import assert from 'node:assert/strict';
import { ageComparisonPayload, comparisonStartDay, hasComparisonData, calendarDays, contribution, monthlyComparison, formatComparisonUsd } from '../shared/protocol-fee-comparison/model.js';
import { comparisonOption, comparisonTooltip } from '../src/lib/protocol-fee-comparison/options.js';
import { buildComparisonTimeSeries } from '../src/lib/protocol-fee-comparison/time-series.js';

const now = Date.parse('2026-09-18T12:00:00Z');
const days = calendarDays('2026-08-01', '2026-09-18').map((day) => ({ day,
  thorchain: contribution(100, 1), near: { ...contribution(20, 200), frontendIncomeUsd: 5, otherIncomeUsd: 15 }, chainflip: contribution(15, 10) }));
const months = monthlyComparison(days, { now, startDay: '2026-08-01', endDay: '2026-09-18' });

test('nonzero daily sub-dollar emissions remain visible in comparison details', () => {
  assert.equal(formatComparisonUsd(0.4658597059627627), '$0.47');
  assert.equal(formatComparisonUsd(-0.4658597059627627), '-$0.47');
  assert.equal(formatComparisonUsd(0), '$0');
  assert.notEqual(formatComparisonUsd(0.00004822), '$0');
  assert.notEqual(formatComparisonUsd(0.00004822), '$0.00');
  assert.equal(formatComparisonUsd(0.00004822), '<$0.01');
  assert.equal(formatComparisonUsd(-0.00004822), '>-$0.01');
  assert.equal(formatComparisonUsd(1234.56), '$1,235');
  assert.equal(formatComparisonUsd(1234.56, true), '$1.2K');
  assert.equal(formatComparisonUsd(0.4658597059627627, true), '$0.5');
});

test('rolling year starts at UTC month boundary and retains twelve full months plus current month', () => {
  assert.equal(comparisonStartDay(now), '2025-09-01');
  assert.equal(comparisonStartDay(Date.parse('2027-01-01T00:00:00Z')), '2026-01-01');
  const year = monthlyComparison(days, { now });
  assert.equal(year.length, 13);
  assert.equal(year[0].month, '2025-09');
  assert.equal(year[0].protocols.thorchain.netUsd, null);
  assert.equal(year.at(-1).month, '2026-09');
  assert.equal(year.at(-1).expectedDays, 17);
});

test('calendar months sum daily USD and retain signed contribution and the current partial month', () => {
  assert.deepEqual(months.map((row) => [row.month, row.partial, row.expectedDays]), [['2026-08', false, 31], ['2026-09', true, 17]]);
  assert.equal(months[0].protocols.thorchain.netUsd, 31 * 99);
  assert.equal(months[1].protocols.near.netUsd, 17 * -180);
  assert.equal(months[1].protocols.near.frontendIncomeUsd, 17 * 5);
  assert.equal(months[1].protocols.near.otherIncomeUsd, 17 * 15);
  assert.equal(months[1].throughDay, '2026-09-17');
});

test('a missing day makes only the affected protocol unavailable; real zero is retained', () => {
  const rows = structuredClone(days);
  rows[0].near = contribution(null, 1);
  rows[1].chainflip = contribution(0, 0);
  const result = monthlyComparison(rows, { now, startDay: '2026-08-01', endDay: '2026-09-18' });
  assert.equal(result[0].protocols.near.netUsd, null);
  assert.equal(result[0].protocols.near.frontendIncomeUsd, null);
  assert.equal(result[0].protocols.near.observedDays, 30);
  assert.equal(result[0].protocols.thorchain.complete, true);
  assert.equal(result[0].protocols.chainflip.netUsd, 30 * 5);
  assert.equal(formatComparisonUsd(null), 'Unavailable');
  assert.equal(formatComparisonUsd(0), '$0');
});

test('a truncated historical month is not presented as complete and inputs are immutable', () => {
  const frozen = days.map((row) => Object.freeze({ ...row }));
  const result = monthlyComparison(Object.freeze(frozen), { now, startDay: '2026-08-19', endDay: '2026-09-18' });
  assert.equal(result[0].protocols.thorchain.netUsd, null);
  assert.equal(result[1].protocols.thorchain.complete, true);
});

test('last month-to-date snapshot becomes unavailable, never a completed historical month', () => {
  const payload = { months, throughDay: '2026-09-17', asOf: new Date(now).toISOString(), stale: false };
  const aged = ageComparisonPayload(payload, Date.parse('2026-10-01'));
  assert.equal(aged.stale, true);
  assert.equal(aged.months[0].protocols.near.netUsd, -5580);
  assert.equal(aged.months[1].partial, false);
  assert.equal(aged.months[1].protocols.near.netUsd, null);
  assert.equal(aged.months[1].protocols.near.frontendIncomeUsd, null);
  assert.equal(aged.months[1].protocols.near.otherIncomeUsd, null);
  assert.equal(aged.months[1].protocols.near.expectedDays, 30);
  assert.equal(payload.months[1].partial, true);
  assert.equal(hasComparisonData(aged), true);
  assert.equal(hasComparisonData({ months: [aged.months[1]] }), false);
});

test('a cached full-calendar month survives aging even if originally marked current', () => {
  const complete = { ...months[0], partial: true };
  const aged = ageComparisonPayload({ months: [complete], throughDay: '2026-08-31' }, now);
  assert.equal(aged.months[0].partial, false);
  assert.equal(aged.months[0].protocols.thorchain.netUsd, 3069);
});

test('chart has monthly categories, grouped signed bars, one zero-based USD axis, and no daily toggle', () => {
  const options = comparisonOption(months);
  assert.deepEqual(options.xAxis.data, ['Aug 2026', 'Sep 2026 *']);
  assert.equal(options.yAxis.scale, false);
  assert.equal(options.series.length, 3);
  assert.equal(options.series[1].data[0].value, -5580);
  assert.ok(options.series.every((series) => !series.stack && series.type === 'bar'));
  assert.deepEqual(options.series[0].markLine.data, [{ yAxis: 0 }]);
  assert.equal(options.series[0].data[1].itemStyle.opacity, .65);
  assert.equal(options.animation, false);
  assert.ok(options.tooltip.textStyle.fontSize >= 12);
});

test('tooltip shows income, subsidy and net without the included NEAR breakdown', () => {
  const tooltip = comparisonTooltip(months[1]);
  assert.match(tooltip, /PARTIAL/);
  assert.match(tooltip, /2026-09-17 UTC/);
  assert.equal((tooltip.match(/data-series=/g) || []).length, 3);
  assert.match(tooltip, /Fees collected:/); assert.match(tooltip, /Deduction:/);
  assert.doesNotMatch(tooltip, /Own frontend|Other retained income/);
  assert.match(tooltip, /Fees collected: \$340<br>Token subsidy \(gross issuance\): \$3,400<br><strong>After subsidy: -\$3,060/);
  assert.doesNotMatch(tooltip, /100% of chain issuance|legacy|mixed/i);
  assert.doesNotMatch(comparisonTooltip(months[0], ['near']), /data-series="near"/);
  assert.equal(comparisonOption(months, ['near']).series.length, 2);
});

test('legacy or incomplete NEAR breakdowns do not affect the displayed total', () => {
  const legacy = structuredClone(months[0]);
  delete legacy.protocols.near.frontendIncomeUsd;
  delete legacy.protocols.near.otherIncomeUsd;
  assert.doesNotMatch(comparisonTooltip(legacy), /Own frontend|Other retained income/);
  assert.equal(comparisonTooltip(legacy), comparisonTooltip(months[0]));
  const missing = structuredClone(days);
  delete missing[0].near.frontendIncomeUsd;
  const result = monthlyComparison(missing, { now, startDay: '2026-08-01', endDay: '2026-09-18' });
  assert.equal(result[0].protocols.near.frontendIncomeUsd, null);
  assert.equal(result[0].protocols.near.incomeUsd, 620);
});

test('net-supply tooltips identify NEAR separately without relabeling TC, CF or old snapshots', () => {
  const monthly = comparisonTooltip(months[1], [], true);
  assert.match(monthly, /Fees collected: \$340<br>Net token supply change: \$3,400/);
  assert.equal((monthly.match(/Token subsidy \(/g) || []).length, 1);
  assert.doesNotMatch(monthly, /including all protocol burns/);
  const daily = buildComparisonTimeSeries(days, { nearNetSupply: true }).tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(daily, /Net token supply change: \$200/);
  assert.doesNotMatch(daily, /including all protocol burns/);
  assert.doesNotMatch(comparisonTooltip(months[1]), /Net token supply change:/);
});

test('tooltip bucket metadata is escaped and missing protocol coverage is never zero income', () => {
  const html = comparisonTooltip({ title: '<img src=x>', fromDay: '<start>', throughDay: '<end>',
    expectedDays: '3<script>', protocols: { near: { complete: false, observedDays: '<b>', expectedDays: '<i>' } } });
  assert.doesNotMatch(html, /<img|<start>|<end>|<script>|<b>|<i>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /0\/3&lt;script&gt; days covered/);
  assert.match(html, /&lt;b&gt;\/&lt;i&gt; days covered/);
  assert.doesNotMatch(html, /Fees collected: \$0/);
});

test('monthly TC accounting preserves gross fees and REVSHARE without changing other protocols', () => {
  const rows = days.map(row => ({ ...row,
    thorchain: { ...contribution(95, 1), grossIncomeUsd: 100, revshareUsd: 5 }
  }));
  const actual = monthlyComparison(rows, { now, startDay: '2026-08-01', endDay: '2026-09-18' });
  for (let index = 0; index < actual.length; index++) {
    const month = actual[index];
    assert.equal(month.protocols.thorchain.grossIncomeUsd, month.expectedDays * 100);
    assert.equal(month.protocols.thorchain.revshareUsd, month.expectedDays * 5);
    assert.equal(month.protocols.thorchain.incomeUsd, month.expectedDays * 95);
    assert.equal(month.protocols.thorchain.subsidyUsd, month.expectedDays);
    assert.equal(month.protocols.thorchain.netUsd, month.expectedDays * 94);
    assert.deepEqual(month.protocols.near, months[index].protocols.near);
    assert.deepEqual(month.protocols.chainflip, months[index].protocols.chainflip);
  }
  const aged = ageComparisonPayload({ months: actual, throughDay: '2026-09-17' }, Date.parse('2026-10-01'));
  assert.equal(aged.months[1].protocols.thorchain.grossIncomeUsd, null);
  assert.equal(aged.months[1].protocols.thorchain.revshareUsd, null);
});

test('monthly TC known fee components remain available without pretending missing emissions are zero', () => {
  const rows = days.map(row => ({ ...row,
    thorchain: { ...contribution(95, null), grossIncomeUsd: 100, revshareUsd: 5 }
  }));
  const [month] = monthlyComparison(rows, { now, startDay: '2026-08-01', endDay: '2026-09-18' });
  assert.equal(month.protocols.thorchain.grossIncomeUsd, 3100);
  assert.equal(month.protocols.thorchain.revshareUsd, 155);
  assert.equal(month.protocols.thorchain.incomeUsd, 2945);
  assert.equal(month.protocols.thorchain.subsidyUsd, null);
  assert.equal(month.protocols.thorchain.netUsd, null);
  assert.equal(month.protocols.thorchain.complete, false);
});
