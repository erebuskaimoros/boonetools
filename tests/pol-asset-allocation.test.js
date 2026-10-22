import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { init, use } from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { buildSystemIncomePolAssetInventory } from '../src/lib/system-income-pol/model.js';
import { allocationShare, buildPolAssetAllocation, buildPolAssetAllocationOption } from '../src/lib/system-income-pol/allocation.js';

const holding = (asset, valueUsdE8, amountE8 = '100000000') => ({
  asset, ticker: asset.split('.')[1].split('-')[0], valueUsdE8, amountE8
});

test('RUNE occupies the bottom semicircle regardless of inventory order', () => {
  use([PieChart, TooltipComponent, SVGRenderer]);
  for (const inventory of [
    [holding('THOR.RUNE', '500000000'), holding('XRP.XRP', '300000000'), holding('ZEC.ZEC', '200000000')],
    [holding('ZEC.ZEC', '200000000'), holding('XRP.XRP', '300000000'), holding('THOR.RUNE', '500000000')],
    [holding('XRP.XRP', null), holding('BSC.BNB', '0'), holding('ZEC.ZEC', '500000000'), holding('THOR.RUNE', '500000000')]
  ]) {
    const allocation = buildPolAssetAllocation(inventory);
    const original = structuredClone(allocation);
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 290 });
    try {
      const option = buildPolAssetAllocationOption(allocation);
      chart.setOption(option);
      const index = option.series[0].data.findIndex(item => item.id === 'THOR.RUNE');
      const layout = chart.getModel().getSeriesByIndex(0).getData().getItemLayout(index);
      const midpoint = (layout.startAngle + layout.endAngle) / 2;
      assert.ok(Math.abs(Math.cos(midpoint)) < 1e-10, 'RUNE center is vertically aligned');
      assert.ok(Math.sin(midpoint) > 0.999999, 'RUNE center points down');
      assert.ok(Math.abs(layout.endAngle - layout.startAngle - Math.PI) < 1e-10, 'RUNE retains its true half-circle');
      assert.deepEqual(allocation, original, 'chart rotation must not mutate holdings');
      assert.deepEqual(option.series[0].data.map(item => item.id), inventory.filter(item => Number(item.valueUsdE8) > 0).map(item => item.asset));
    } finally { chart.dispose(); }
  }
});

test('bottom anchoring preserves actual RUNE share rather than forcing a half-circle', () => {
  use([PieChart, TooltipComponent, SVGRenderer]);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 290 });
  try {
    const option = buildPolAssetAllocationOption(buildPolAssetAllocation([
      holding('XRP.XRP', '800000000'), holding('THOR.RUNE', '200000000')
    ]));
    chart.setOption(option);
    const layout = chart.getModel().getSeriesByIndex(0).getData().getItemLayout(1);
    assert.ok(Math.sin((layout.startAngle + layout.endAngle) / 2) > 0.999999);
    assert.ok(Math.abs(layout.endAngle - layout.startAngle - 0.4 * Math.PI) < 1e-10);
    assert.deepEqual(option.series[0].data.map(item => item.percent), [80, 20]);
  } finally { chart.dispose(); }
});

test('POL allocation uses USD pool legs plus aggregate RUNE exactly once, not token counts', () => {
  const inventory = buildSystemIncomePolAssetInventory({ totalRuneHeldE8: '90000000000', totalRuneHeldUsdE8: '50000000000' }, [
    { asset: 'XRP.XRP', assetHeldE8: '99900000000', assetValueUsdE8: '30000000000', runeHeldE8: '80000000000' },
    { asset: 'ZEC.ZEC', assetHeldE8: '1', assetValueUsdE8: '20000000000', runeHeldE8: '10000000000' }
  ]);
  const allocation = buildPolAssetAllocation(inventory);
  assert.equal(allocation.totalLabel, '$1,000.00');
  assert.deepEqual(allocation.assets.map(item => item.percent), [50, 30, 20]);
  const option = buildPolAssetAllocationOption(allocation);
  assert.equal(option.series[0].type, 'pie');
  assert.deepEqual(option.series[0].data.map(item => item.value), [500, 300, 200]);
  assert.equal(option.animation, false);
  assert.equal(option.series[0].minAngle, 0);
  const runeTooltip = option.tooltip.formatter({ data: option.series[0].data[0] });
  assert.match(runeTooltip, /900.00 RUNE/);
  assert.match(runeTooltip, /\$500.00 · 50.0% of total holdings/);
});

test('unpriced, zero, and invalid holdings remain visible without invented slices', () => {
  const allocation = buildPolAssetAllocation([
    holding('THOR.RUNE', '100000000'), holding('XRP.XRP', null),
    holding('ZEC.ZEC', '0'), holding('TRON.TRX', '-1'), holding('BSC.BNB', 'bad')
  ]);
  assert.equal(allocation.incomplete, true);
  assert.equal(allocation.assets.length, 5);
  assert.deepEqual(allocation.assets.map(item => item.percent), [100, null, 0, null, null]);
  assert.equal(allocation.assets[1].valueLabel, 'USD unavailable');
  const option = buildPolAssetAllocationOption(allocation);
  assert.equal(option.series[0].data.length, 1);
  assert.match(option.tooltip.formatter({ data: option.series[0].data[0] }), /of priced holdings/);
  for (const values of [[], [holding('THOR.RUNE', '0')], [holding('THOR.RUNE', null)]]) {
    const empty = buildPolAssetAllocation(values);
    assert.equal(empty.hasValue, false);
    assert.deepEqual(buildPolAssetAllocationOption(empty).series[0].data, []);
    assert.equal(buildPolAssetAllocationOption(empty).series[0].stillShowZeroSum, false);
  }
});

test('POL holdings and pie tooltips use CHAIN.ASSET labels while retaining full asset identities', () => {
  const assets = ['THOR.RUNE', 'XRP.XRP', 'TRON.USDT-contract', 'TRON.TRX', 'BSC.USDT-contract', 'BASE.USDC-contract', 'ZEC.ZEC'];
  const labels = ['THOR.RUNE', 'XRP.XRP', 'TRON.USDT', 'TRON.TRX', 'BSC.USDT', 'BASE.USDC', 'ZEC.ZEC'];
  const allocation = buildPolAssetAllocation(assets.map(asset => holding(asset, '100000000')));
  assert.deepEqual(allocation.assets.map(item => item.label), labels);
  assert.deepEqual(allocation.assets.map(item => item.asset), assets);
  const option = buildPolAssetAllocationOption(allocation);
  assert.deepEqual(option.series[0].data.map(item => item.name), labels);
  assert.deepEqual(option.series[0].data.map(item => item.id), assets);
  for (const item of option.series[0].data) {
    assert.ok(option.tooltip.formatter({ data: item }).includes(item.name));
  }
});

test('chain-specific stablecoins keep distinct labels/colors and tiny holdings retain true proportions', () => {
  const inventory = [holding('TRON.USDT-contract', '99999999999'), holding('BSC.USDT-contract', '1')];
  const allocation = buildPolAssetAllocation(inventory);
  assert.deepEqual(allocation.assets.map(item => item.label), ['TRON.USDT', 'BSC.USDT']);
  assert.notEqual(allocation.assets[0].color, allocation.assets[1].color);
  assert.equal(allocationShare(allocation.assets[1].percent), '<0.1%');
  assert.equal(allocationShare(0), '0.0%');
  assert.equal(allocationShare(null), '—');
  assert.deepEqual(buildPolAssetAllocation(inventory.toReversed()).assets.map(item => item.color).toReversed(), allocation.assets.map(item => item.color));
  assert.equal(buildPolAssetAllocationOption(allocation).series[0].data.length, 2);
  assert.equal(buildPolAssetAllocationOption(allocation).series[0].startAngle, 90, 'without priced RUNE, retain the default orientation');
});

test('pie tooltip escapes source labels', () => {
  const allocation = buildPolAssetAllocation([holding('XRP.<img onerror=alert(1)>', '100000000')]);
  const option = buildPolAssetAllocationOption(allocation);
  const tooltip = option.tooltip.formatter({ data: option.series[0].data[0] });
  assert.doesNotMatch(tooltip, /<img/);
  assert.match(tooltip, /&lt;img/);
});

test('real ECharts pie renders a full circle and proportionate slices, then updates to empty', () => {
  use([PieChart, TooltipComponent, SVGRenderer]);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 290 });
  try {
    chart.setOption(buildPolAssetAllocationOption(buildPolAssetAllocation([holding('THOR.RUNE', '100000000')])));
    assert.match(chart.renderToSVGString(), /<path/);
    chart.setOption(buildPolAssetAllocationOption(buildPolAssetAllocation([holding('THOR.RUNE', '500000000'), holding('XRP.XRP', '300000000'), holding('ZEC.ZEC', '200000000')])), { notMerge: true });
    assert.equal(chart.getOption().series[0].data.length, 3);
    const svg = chart.renderToSVGString();
    assert.match(svg, /#00cc66/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
    chart.setOption(buildPolAssetAllocationOption(buildPolAssetAllocation([])), { notMerge: true });
    assert.deepEqual(chart.getOption().series[0].data, []);
  } finally { chart.dispose(); }
});

test('holdings retain an accessible HTML key, responsive rendering, and chart cleanup', async () => {
  const source = await readFile(new URL('../src/lib/system-income-pol/AssetAllocation.svelte', import.meta.url), 'utf8');
  assert.match(source, /<ul aria-label="POL asset amounts and allocation shares"/);
  assert.match(source, /asset\.amountLabel/);
  assert.match(source, /asset\.valueLabel/);
  assert.match(source, /allocationShare\(asset.percent\)/);
  assert.match(source, /title=\{asset.asset\}/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /chart\?\.dispose\(\)/);
  assert.match(source, /@container sipol \(max-width: 650px\)/);
  const dashboard = await readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8');
  assert.match(dashboard, /<AssetAllocation inventory=\{assetInventory\} \{loading\}/);
  assert.match(dashboard, /container: sipol \/ inline-size/);
  assert.match(dashboard, /@container sipol \(min-width: 1320px\)[\s\S]*?grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(dashboard, /asset-grid|metric:nth-child/);
});
