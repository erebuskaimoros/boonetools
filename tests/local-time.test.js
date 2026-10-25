import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalDateTime, formatLocalTime, formatLocalHour, localDateKey, localTimeZone } from '../src/lib/utils/datetime.js';
import { localHourLabels } from '../src/lib/charts/hour-labels.js';
import { formatFinancialDay } from '../shared/financials/model.js';
import { buildFinancialHourlyOption, buildFinancialEChartsOption } from '../src/lib/financials/echarts-options.js';

test('timestamps use the browser timezone by default, including historical DST', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(localTimeZone(), 'America/New_York');
    assert.match(formatLocalDateTime('2026-10-25T01:15:00Z'), /Oct 24, 2026, 21:15:00 EDT/);
    assert.equal(formatLocalTime('2026-01-25T01:15:00Z'), '20:15:00 EST');
    const rows = ['2026-10-25T03:00:00Z', '2026-10-25T04:00:00Z'].map((day, index) => ({
      day, through: Date.parse(day) / 1000 + 3600, volumeUsd: index + 10, incomeUsd: index + 1, runePriceUsd: .6
    }));
    const option = buildFinancialHourlyOption(rows);
    assert.deepEqual(option.xAxis.data, rows.map(row => row.day));
    assert.deepEqual(option.series[0].data, [10, 11]);
    assert.equal(option.xAxis.axisLabel.formatter(rows[0].day), 'Oct 24\n23:00');
    assert.equal(option.xAxis.axisLabel.formatter(rows[1].day), 'Oct 25\n00:00');
    assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /Oct 24, 23:00 EDT/);
    assert.equal(buildFinancialEChartsOption([{ day: '2026-10-25' }]).xAxis.axisLabel.formatter('2026-10-25', 0), 'Oct 25');
    process.env.TZ = 'Asia/Kathmandu';
    assert.equal(formatLocalHour('2026-10-25T01:15:00Z'), 'Oct 25, 07:00');
    assert.equal(localDateKey('2026-10-24T23:00:00Z'), '2026-10-25');
    // Reporting dates never become the previous local day.
    assert.match(formatFinancialDay('2026-10-25'), /Oct 25/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('missing timestamps and date-only bucket keys do not turn into invented instants', () => {
  for (const value of [null, undefined, '', 'invalid', '2026-10-25']) {
    assert.equal(formatLocalDateTime(value), '—');
    assert.equal(localDateKey(value), '');
  }
  assert.notEqual(formatLocalDateTime(0), '—');
});

test('hour labels change dates at local midnight, including fractional timezone offsets', () => {
  const rows = ['2026-10-24T17:00:00Z', '2026-10-24T18:00:00Z', '2026-10-24T19:00:00Z'].map(day => ({ day }));
  const labels = localHourLabels(rows, { timeZone: 'Asia/Kathmandu' });
  assert.deepEqual([...labels.values()], ['Oct 24\n22:45', '\n23:45', 'Oct 25\n00:45']);
  const ny = localHourLabels(rows, { timeZone: 'America/New_York' });
  assert.deepEqual([...ny.values()], ['Oct 24\n13:00', '\n14:00', '\n15:00']);
});

test('DST repeated hours remain distinct, and skipped hours are not fabricated', () => {
  const fall = ['2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'].map(day => ({ day }));
  assert.deepEqual([...localHourLabels(fall, { timeZone: 'America/New_York' }).values()],
    ['Nov 1\n01:00 EDT', '\n01:00 EST', '\n02:00']);
  const spring = ['2026-03-08T06:00:00Z', '2026-03-08T07:00:00Z'].map(day => ({ day }));
  assert.deepEqual([...localHourLabels(spring, { timeZone: 'America/New_York' }).values()], ['Mar 8\n01:00', '\n03:00']);
});
