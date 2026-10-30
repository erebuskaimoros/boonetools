import test from 'node:test';
import assert from 'node:assert/strict';
import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { normalizeSystemIncomePolPayload, buildSystemIncomePolChart } from '../src/lib/system-income-pol/model.js';
import { buildSystemIncomePolDepositOption } from '../src/lib/system-income-pol/charts.js';

const windows = [7, 30, 90];
const rolling = windows.map(days => `total-${days}d`);
function history(unit = 'rune') {
  let cumulative = 1000;
  const daily = Array.from({ length: 100 }, (_, index) => {
    const total = index + 1;
    cumulative += total;
    return {
      day: new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10),
      deployed_e8: String(total * 1e8), cumulative_deployed_e8: String(cumulative * 1e8),
      rune_price_usd: String(index % 4 + 1), partial: index === 99,
      pool_deposits: [
        { asset: 'XRP.XRP', deployed_e8: String(total * 4e7) },
        { asset: 'TRON.TRX', deployed_e8: String(total * 5e7) }
      ]
    };
  });
  return buildSystemIncomePolChart(normalizeSystemIncomePolPayload({ daily }).daily, { unit }).points;
}

test('POL TOTAL is a rolling-only source, never an extra bar, legend entry, or cumulative average', () => {
  const rows = history();
  const base = buildSystemIncomePolDepositOption(rows);
  assert.equal(base._spec.rollingSeries?.[0]?.id, 'total');
  assert.equal(base._spec.rollingSeries[0].label, 'TOTAL');
  assert.deepEqual(base._spec.rollingSeries[0].data, rows.map(row => row.depositedPlotValue));
  assert.equal(base._spec.series.some(item => item.id === 'total'), false);
  const option = buildSystemIncomePolDepositOption(rows, { analysis: { rolling: [...rolling, 'cumulative-7d'] } });
  assert.equal(option.series.length, base.series.length + 3);
  assert.equal(option.series.some(item => item.id === 'cumulative-7d'), false);
  assert.deepEqual(option.series.filter(item => item.type === 'bar'), base.series.filter(item => item.type === 'bar'));
  for (const [index, days] of windows.entries()) {
    const average = option.series.find(item => item.id === `total-${days}d`);
    assert.equal(average.type, 'line');
    assert.equal(average.yAxisIndex, 0);
    assert.equal(average.stack, undefined);
    assert.equal(average.lineStyle.type, ['solid', 'dashed', 'dotted'][index]);
    assert.equal(average.data[days - 2], null);
    assert.equal(average.data.at(-1), [97, 85.5, 55.5][index]);
  }
});

test('TOTAL averages include hidden pools and unattributed deposits, with daily historical USD and off-screen lookback', () => {
  for (const unit of ['rune', 'usd']) for (const grain of ['day', 'week', 'month']) {
    const allRows = history(unit), rows = allRows.slice(-10);
    const option = buildSystemIncomePolDepositOption(rows, { unit,
      window: { startDay: rows[3].day, endDay: rows.at(-1).day },
      analysis: { grain, rolling, hidden: ['pool:XRP.XRP', 'daily', 'cumulative'],
        historyRows: allRows, historySpec: buildSystemIncomePolDepositOption(allRows, { unit })._spec }
    });
    for (const days of windows) {
      const expected = allRows.slice(-days).reduce((sum, row) => sum + row.depositedPlotValue, 0) / days;
      assert.equal(option.series.find(item => item.id === `total-${days}d`).data.at(-1), expected);
    }
    assert.equal(option.yAxis[0].show, true);
    assert.equal(option.yAxis[1].show, false);
    const tooltip = option.tooltip.formatter([{ dataIndex: option._rows.length - 1 }]);
    assert.match(tooltip, /7D AVG · TOTAL:/);
    assert.match(tooltip, /90D AVG · TOTAL:/);
    assert.match(tooltip, unit === 'usd' ? /7D AVG · TOTAL: \$/ : /7D AVG · TOTAL: .* RUNE/);
  }
});

test('TOTAL rolling windows retain zeros and gaps, and fresh missing values override cached history', () => {
  const allRows = history();
  const average = (rows, analysis = {}) => buildSystemIncomePolDepositOption(rows, {
    analysis: { rolling: ['total-7d'], ...analysis }
  }).series.find(item => item.id === 'total-7d');
  assert.ok(average(allRows.slice(-6)).data.every(value => value === null));
  assert.equal(average(allRows.filter((_, index) => index !== 95)).data.at(-1), null);
  const zeroRows = allRows.slice(-7).map(row => ({ ...row, depositedPlotValue: 0 }));
  assert.equal(average(zeroRows).data.at(-1), 0);
  const fresh = allRows.slice(-10).map((row, index) => ({ ...row, depositedPlotValue: index === 9 ? null : row.depositedPlotValue }));
  assert.equal(average(fresh, { historyRows: allRows, historySpec: buildSystemIncomePolDepositOption(allRows)._spec }).data.at(-1), null);
});

test('real ECharts adds and removes total averages without changing pool stacks or cumulative values', () => {
  use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 280 });
  try {
    const rows = history();
    const base = buildSystemIncomePolDepositOption(rows);
    const selected = buildSystemIncomePolDepositOption(rows, { analysis: { rolling } });
    chart.setOption(selected);
    assert.equal(chart.getOption().series.filter(item => item.id.startsWith('total-')).length, 3);
    assert.match(chart.renderToSVGString(), /<path/);
    assert.doesNotMatch(chart.renderToSVGString(), /NaN|Infinity/);
    chart.setOption(base, { notMerge: true });
    assert.equal(chart.getOption().series.some(item => item.id.startsWith('total-')), false);
    assert.deepEqual(chart.getOption().series.find(item => item.id === 'cumulative').data, rows.map(row => row.cumulativeDepositedValue));
  } finally { chart.dispose(); }
});
