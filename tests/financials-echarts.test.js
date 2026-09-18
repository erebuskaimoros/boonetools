import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialEChartsOption, financialEChartsTooltip, financialEChartsWindow } from '../src/lib/financials/echarts-options.js';
import { financialChartIndices, financialChartWindow } from '../src/lib/financials/series.js';

const rows = Array.from({ length: 6 }, (_, index) => ({
  day: `2026-09-0${index + 1}`, volumeUsd: index * 1000, volumeRune: index * 5000,
  incomeUsd: index * 10, incomeRune: index * 50,
  bondingApr: index === 2 ? null : index + 1,
  feesRune: 2, blockRewardsRune: 3, bondingEarningsRune: 2, activeBondRune: 100,
  ...(index === 5 ? { partial: true, through: Date.parse('2026-09-06T12:00:00Z') / 1000 } : {})
}));

test('ECharts uses the same units, three independent axes, colors and drawing order', () => {
  const options = buildFinancialEChartsOption(rows);
  assert.deepEqual(options.yAxis.map((axis) => axis.id), ['volume', 'income', 'bondingApr']);
  assert.deepEqual(options.series.slice(0, 3).map((series) => series.yAxisIndex), [0, 1, 2]);
  assert.deepEqual(options.series.slice(0, 3).map((series) => series.z), [2, 1, 3]);
  assert.deepEqual(options.yAxis.map((axis) => axis.axisLine.lineStyle.color), ['#5588cc', '#00cc66', '#d4a017']);
  assert.deepEqual(options.series[0].data, rows.map((row) => row.volumeUsd));
  const rune = buildFinancialEChartsOption(rows, { currency: 'rune' });
  assert.deepEqual(rune.series[0].data, rows.map((row) => row.volumeRune));
  assert.deepEqual(rune.series[1].data, rows.map((row) => row.incomeRune));
  assert.deepEqual(rune.series[2].data, options.series[2].data);
});

test('the partial APR segment is dashed and never fills a missing day', () => {
  const options = buildFinancialEChartsOption(rows);
  assert.deepEqual(options.series[2].data, [1, 2, null, 4, 5, null]);
  assert.deepEqual(options.series[3].data, [null, null, null, null, 5, 6]);
  assert.equal(options.series[3].lineStyle.type, 'dashed');
  assert.equal(options.series[2].connectNulls, false);
  const missing = rows.map((row, index) => index === 4 ? { ...row, bondingApr: null } : row);
  assert.deepEqual(buildFinancialEChartsOption(missing).series[3].data, [null, null, null, null, null, 6]);
});

test('null amounts stay missing, real zero stays zero, and inputs are not mutated', () => {
  const points = rows.map((row, index) => Object.freeze(index === 1 ? { ...row, volumeUsd: null } : { ...row }));
  Object.freeze(points);
  const options = buildFinancialEChartsOption(points);
  assert.equal(options.series[0].data[0], 0);
  assert.equal(options.series[0].data[1], null);
});

test('hiding APR hides both APR series and its axis, and compacts right-axis space', () => {
  const options = buildFinancialEChartsOption(rows, { hidden: ['bondingApr'] });
  assert.equal(options.yAxis[2].show, false);
  assert.deepEqual(options.series[2].data, []);
  assert.deepEqual(options.series[3].data, []);
  assert.equal(buildFinancialEChartsOption(rows, { hidden: ['income'] }).yAxis[2].offset, 0);
  assert.ok(options.grid.right < buildFinancialEChartsOption(rows).grid.right);
});

test('both renderers share inclusive UTC-day windows and handle full/empty ranges', () => {
  const window = { startDay: rows[1].day, endDay: rows[4].day };
  assert.deepEqual(financialChartIndices(rows, window), { start: 1, end: 4 });
  assert.deepEqual(financialChartWindow(rows, 0.5, 4.5), window);
  assert.equal(financialChartWindow(rows, 0, rows.length - 1), null);
  assert.equal(financialChartWindow([], 0, 0), null);
  assert.deepEqual(financialChartIndices(rows, { startDay: '2027-01-01', endDay: '2027-02-01' }), { start: 0, end: 5 });
});

test('zoom accepts ECharts category values, indices, and percentages without changing dates', () => {
  const window = { startDay: rows[1].day, endDay: rows[4].day };
  assert.deepEqual(financialEChartsWindow(rows, { startValue: 1, endValue: 4 }), window);
  assert.deepEqual(financialEChartsWindow(rows, { startValue: rows[1].day, endValue: rows[4].day }), window);
  assert.deepEqual(financialEChartsWindow(rows, { start: 20, end: 80 }), window);
  const options = buildFinancialEChartsOption(rows, { window });
  assert.equal(options.dataZoom[0].startValue, 1);
  assert.equal(options.dataZoom[0].endValue, 4);
  assert.equal(options.dataZoom[0].start, undefined);
});

test('tooltip retains completeness/coverage details and has only one APR value', () => {
  const text = financialEChartsTooltip(rows[5], 'usd');
  assert.match(text, /UTC · IN PROGRESS/);
  assert.match(text, /Through 12:00:00 UTC/);
  assert.match(text, /elapsed-time annualized estimate/);
  assert.equal(text.match(/BONDING APR:/g).length, 1);
  assert.match(financialEChartsTooltip(rows[2], 'usd'), /bond snapshot unavailable/);
  assert.doesNotMatch(financialEChartsTooltip(rows[5], 'usd', ['volume']), /DAILY VOLUME:/);
});

test('tooltip renders square series-color swatches before the three metric labels', () => {
  const options = buildFinancialEChartsOption(rows);
  assert.equal(options.tooltip.renderMode, 'html');
  const html = options.tooltip.formatter([{ axisValue: rows[5].day, dataIndex: 5 }]);
  for (const [index, label] of ['DAILY VOLUME', 'SYSTEM INCOME', 'BONDING APR'].entries()) {
    const series = options.series[index];
    const swatch = html.match(new RegExp(`<span[^>]*data-series="${series.id}"[^>]*></span> ${label}:`))?.[0];
    assert.ok(swatch, `${label} has a swatch before its label`);
    assert.ok(swatch.includes(`background-color:${series.itemStyle.color}`));
    assert.ok(swatch.includes(`border:1px solid ${series.itemStyle.borderColor ?? series.itemStyle.color}`));
    assert.ok(swatch.includes('border-radius:0'));
    assert.ok(swatch.includes('aria-hidden="true"'));
  }
  assert.equal((html.match(/data-series=/g) ?? []).length, 3);
  assert.match(html, /<br>Liquidity fees:/);
});

test('tooltip swatches follow series visibility, currency, and partial APR without duplicates', () => {
  for (const hidden of [['volume'], ['income'], ['bondingApr'], ['volume', 'income', 'bondingApr']]) {
    const html = financialEChartsTooltip(rows[5], 'rune', hidden);
    assert.equal((html.match(/data-series=/g) ?? []).length, 3 - hidden.length);
    for (const id of hidden) assert.ok(!html.includes(`data-series="${id}"`));
    assert.match(html, /Through 12:00:00 UTC/);
    assert.match(html, /Liquidity fees:/);
  }
  assert.match(financialEChartsTooltip(rows[5], 'rune'), /DAILY VOLUME: 25,000 ᚱ/);
  assert.equal(financialEChartsTooltip(null, 'usd'), '');
});

test('narrow layouts retain readable fonts and reduce axes/ticks without dropping series', () => {
  const options = buildFinancialEChartsOption(rows, { width: 340 });
  assert.ok(options.yAxis.every((axis) => axis.name === '' && axis.axisLabel.fontSize >= 11));
  assert.ok(options.tooltip.textStyle.fontSize >= 12);
  assert.equal(options.animation, false);
  assert.equal(options.series.length, 4);
  assert.ok(options.grid.left + options.grid.right < 250);
});

test('the real ECharts model preserves a UTC window across live updates and resets fully', async () => {
  const { init, use } = await import('echarts/core');
  const { BarChart, LineChart } = await import('echarts/charts');
  const { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } = await import('echarts/components');
  const { SVGRenderer } = await import('echarts/renderers');
  use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 430 });
  const readWindow = (points) => financialEChartsWindow(points, chart.getOption().dataZoom.find((zoom) => zoom.id === 'financials-window'));
  try {
    chart.setOption(buildFinancialEChartsOption(rows));
    chart.dispatchAction({ type: 'dataZoom', dataZoomId: 'financials-window', startValue: 1, endValue: 4 });
    const window = { startDay: rows[1].day, endDay: rows[4].day };
    assert.deepEqual(readWindow(rows), window);
    const updated = [...rows.map((row) => ({ ...row, volumeUsd: row.volumeUsd + 1 })), { ...rows[5], day: '2026-09-07' }];
    chart.setOption(buildFinancialEChartsOption(updated, { window }), { replaceMerge: ['series'], silent: true });
    assert.deepEqual(readWindow(updated), window);
    chart.setOption(buildFinancialEChartsOption(updated), { replaceMerge: ['series'], silent: true });
    assert.equal(readWindow(updated), null);
    assert.match(chart.renderToSVGString(), /<svg/);
  } finally { chart.dispose(); }
});
