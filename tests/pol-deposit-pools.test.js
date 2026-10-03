import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { mergePoolDeposits } from '../shared/system-income-pol/deposits.js';
import { normalizeSystemIncomePolPayload, buildSystemIncomePolChart, applySystemIncomePolHead } from '../src/lib/system-income-pol/model.js';
import { buildSystemIncomePolDepositOption, polDepositBuckets, polDepositTooltip, polPoolSeries } from '../src/lib/system-income-pol/charts.js';
import { replaySystemIncomePolHeads } from '../src/lib/system-income-pol/live.js';

const deposit = (asset, rune) => ({ asset, deployed_e8: String(rune * 1e8) });
const payload = { live: { through_height: 10 }, daily: [
  { day: '2026-09-01', deployed_e8: '10000000000', cumulative_deployed_e8: '50000000000', rune_price_usd: '2', pool_deposits: [deposit('TRON.USDT', 80), deposit('XRP.XRP', 20)] },
  { day: '2026-09-02', deployed_e8: '2000000000', cumulative_deployed_e8: '52000000000', rune_price_usd: '3', pool_deposits: [deposit('XRP.XRP', 20)], partial: true }
] };
const points = (input = payload, unit = 'rune') => buildSystemIncomePolChart(normalizeSystemIncomePolPayload(input).daily, { unit }).points;
use([BarChart, LineChart, DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);

test('real ECharts renderer stacks pool bars to the daily total, independently of the cumulative scale', () => {
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 280 });
  try {
    chart.setOption(buildSystemIncomePolDepositOption(points()));
    const data = chart.getModel().getSeriesByIndex(1).getData();
    assert.equal(data.get(data.getCalculationInfo('stackResultDimension'), 0), 100);
    assert.equal(data.get(data.getCalculationInfo('stackResultDimension'), 1), 20);
    assert.match(chart.renderToSVGString(), /<svg/);
    chart.setOption(buildSystemIncomePolDepositOption(points(), { analysis: { hidden: ['pool:TRON.USDT'] } }), { notMerge: true });
    const visible = chart.getModel().getSeriesByIndex(1).getData();
    assert.equal(visible.get(visible.getCalculationInfo('stackResultDimension'), 0), 20);
    assert.equal(chart.getOption().series.at(-1).data[0], 500);
  } finally { chart.dispose(); }
});

test('current recipient pools have distinct colors that do not depend on their position in the legend', () => {
  const assets = ['ZEC.ZEC', 'XRP.XRP', 'TRON.TRX', 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T'];
  assert.equal(new Set(assets.map(asset => polPoolSeries(asset).color)).size, assets.length);
});

test('exact pool sums preserve large base-unit integers and reject malformed entries', () => {
  assert.deepEqual(mergePoolDeposits([{ asset: 'BTC.BTC', deployed_e8: '9007199254740993' }], [
    { asset: 'BTC.BTC', rune_e8: '2' }, { asset: '', rune_e8: '7' }, { asset: 'ETH.ETH', rune_e8: '-1' }
  ]), [{ asset: 'BTC.BTC', deployed_e8: '9007199254740995' }]);
});

test('stacked recipient bars reconcile to daily totals in both denominations; cumulative anchor remains all-time', () => {
  for (const unit of ['rune', 'usd']) {
    const rows = points(payload, unit), option = buildSystemIncomePolDepositOption(rows, { unit });
    const bars = option.series.filter(item => item.type === 'bar');
    assert.equal(bars.length, 2);
    assert.ok(bars.every(item => item.stack === 'deposits' && item.yAxisIndex === 0));
    rows.forEach((row, index) => assert.equal(bars.reduce((sum, series) => sum + series.data[index], 0), row.depositedPlotValue));
    assert.equal(option.series.at(-1).data.at(-1), unit === 'rune' ? 520 : 260);
    const narrowed = buildSystemIncomePolDepositOption(rows.slice(1), { unit });
    assert.equal(narrowed.series[0].itemStyle.color, option.series.find(item => item.id === narrowed.series[0].id).itemStyle.color);
  }
});

test('weekly/monthly stacks sum historical dollars, keep closing cumulative totals and meaningful pool tooltips', () => {
  const rows = points(payload, 'usd');
  for (const grain of ['week', 'month']) {
    const option = buildSystemIncomePolDepositOption(rows, { unit: 'usd', analysis: { grain } });
    assert.deepEqual(option.series.map(item => item.data[0]), [160, 100, 260]);
    const tooltip = option.tooltip.formatter([{ dataIndex: 0 }]);
    assert.match(tooltip, /TOTAL DEPOSITED · ALL POOLS: \$260.00/);
    assert.match(tooltip, /XRP · XRP: \$100.00 · 38.5%/);
    assert.match(tooltip, /PARTIAL/);
    assert.match(tooltip, /each day at its own closing price/);
    assert.equal(polDepositBuckets(rows, grain)[0].poolDeposits[1].value, 100);
  }
});

test('missing historical prices and interior calendar gaps never become zero or partial totals', () => {
  const rows = points({ daily: payload.daily.map((row, i) => ({ ...row, rune_price_usd: i ? null : row.rune_price_usd })) }, 'usd');
  const option = buildSystemIncomePolDepositOption(rows, { unit: 'usd' });
  assert.deepEqual(option.series[1].data, [40, null]);
  assert.deepEqual(option.series[0].data, [160, 0]);
  assert.equal(polDepositBuckets(rows, 'month')[0].depositedPlotValue, null);
  const gapped = [points()[0], { ...points()[1], day: '2026-09-04' }];
  assert.equal(polDepositBuckets(gapped, 'week')[0].poolDeposits[0].value, null);
  assert.equal(buildSystemIncomePolDepositOption(gapped, { analysis: { grain: 'week' } }).series[0].data[0], null);
});

test('older/incomplete/inconsistent snapshots show an explicit unattributed remainder, not invented recipients', () => {
  for (const pool_deposits of [undefined, [deposit('XRP.XRP', 20)], [deposit('XRP.XRP', 101)]]) {
    const rows = points({ daily: [{ ...payload.daily[0], pool_deposits }] });
    const option = buildSystemIncomePolDepositOption(rows);
    assert.equal(option.series.filter(item => item.type === 'bar').reduce((sum, item) => sum + item.data[0], 0), 100);
    assert.match(polDepositTooltip(rows[0]), /UNATTRIBUTED/);
  }
});

test('pool toggles hide only that pool; rolling overlays are non-stacked daily means', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ ...points()[0], day: `2026-09-${String(index + 1).padStart(2, '0')}` }));
  const option = buildSystemIncomePolDepositOption(rows, { analysis: { grain: 'month', hidden: ['pool:XRP.XRP'], rolling: ['pool:TRON.USDT-7d', 'cumulative-7d'] } });
  assert.deepEqual(option.series.find(item => item.id === 'pool:XRP.XRP').data, []);
  assert.equal(option.series.at(-1).data[0], 80);
  assert.equal(option.series.at(-1).stack, undefined);
  const tooltip = option.tooltip.formatter([{ dataIndex: 0 }]);
  assert.doesNotMatch(tooltip, /XRP · XRP:/);
  assert.match(tooltip, /TOTAL DEPOSITED · ALL POOLS: 1,000.00 RUNE/);
  assert.match(tooltip, /Totals include hidden pools/);
});

test('live replay updates exact pool attribution once, supports new pools and keeps UTC days separate', () => {
  const head = { height: 11, time: '2026-09-02T23:59:59Z', pol_reserve_deployments: [{ asset: 'TRON.TRX', rune_e8: '100000000' }] };
  const live = applySystemIncomePolHead(payload, head);
  assert.equal(live.daily[1].pool_deposits.find(row => row.asset === 'TRON.TRX').deployed_e8, '100000000');
  assert.deepEqual(applySystemIncomePolHead(live, head), live);
  assert.equal(payload.daily[1].pool_deposits.length, 1);
  const corrected = { ...head, pol_reserve_deployments: [{ asset: 'TRON.TRX', rune_e8: '200000000' }] };
  const replayed = replaySystemIncomePolHeads(payload, [corrected]);
  assert.equal(replayed.daily[1].pool_deposits.find(row => row.asset === 'TRON.TRX').deployed_e8, '200000000');
  const midnight = applySystemIncomePolHead(live, { ...head, height: 12, time: '2026-09-03T00:00:01Z' });
  assert.equal(midnight.daily.at(-1).pool_deposits[0].deployed_e8, '100000000');
  assert.equal(points(midnight, 'usd').at(-1).poolDeposits[0].value, null);
});

test('tooltip escapes pool identifiers, uses trusted local token logos and keeps per-day percentages', () => {
  const tooltip = polDepositTooltip(points()[0]);
  assert.match(tooltip, /USDT · TRON: 80.00 RUNE · 80.0%/);
  assert.match(tooltip, /src="\/assets\//);
  const evil = { ...points()[0], poolDeposits: [{ asset: 'EVIL.<script>', rune: 1, value: 1 }] };
  assert.doesNotMatch(polDepositTooltip(evil), /<script>/);
  assert.equal(polPoolSeries('TRON.USDT').color, polPoolSeries('TRON.USDT').color);
});

test('keyboard and touch users can inspect a UTC bucket without interacting with canvas', async () => {
  const source = await readFile(new URL('../src/lib/system-income-pol/DepositInspector.svelte', import.meta.url), 'utf8');
  assert.match(source, /<label for="pol-deposit-bucket"/);
  assert.match(source, /<select id="pol-deposit-bucket"/);
  assert.match(source, /polDepositBuckets\(rows, grain\)/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /event.key === 'Escape'/);
});
