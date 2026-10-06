import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'svelte/compiler';
import { formatUSD } from '../src/lib/utils/formatting.js';
import { formatTcFeeBps } from '../src/lib/tc-fee-dash/presentation.js';

function components(node, name) {
  if (!node || typeof node !== 'object') return [];
  return [
    ...(node.type === 'InlineComponent' && node.name === name ? [node] : []),
    ...Object.values(node).flatMap(value => Array.isArray(value)
      ? value.flatMap(child => components(child, name))
      : components(value, name))
  ];
}

async function toolbarMetrics(filename, declarations, bindings = {}) {
  const source = await readFile(new URL(`../src/lib/${filename}`, import.meta.url), 'utf8');
  const ast = parse(source);
  const helpers = ast.instance.content.body.filter(node => (
    declarations.includes(node.id?.name)
      || node.declarations?.some(declaration => declarations.includes(declaration.id.name))
  )).map(node => source.slice(node.start, node.end)).join('\n');
  return components(ast.html, 'LegacyChartTools').map(node => {
    const expression = node.attributes.find(attribute => attribute.name === 'metrics')?.value[0]?.expression;
    if (!expression) {
      assert.equal(node.attributes.find(attribute => attribute.name === 'sourceGrain')?.value[0]?.data, 'epoch');
      return null; // Native epoch charts intentionally offer no rolling averages.
    }
    const evaluate = new Function(...Object.keys(bindings), `${helpers}\nreturn (${source.slice(expression.start, expression.end)});`);
    return evaluate(...Object.values(bindings));
  }).filter(Boolean);
}

const sample = {
  volumeUsd: 165585.752, feesUsd: 324.291, rateFeesUsd: 324.291,
  feesPerBillionUsd: 1234.5, incomeVolumeBps: 3.25,
  wasmLiquidityFeeUsd: 1234.5, linkedTcReserveUsd: 1234.5, wasmLegVolumeUsd: 1234.5,
  wasmNetworkVolumeShare: 0.375, tcPerMillionWasmVolumeUsd: 1234.5,
  tcPerMillionNetworkVolumeUsd: 1234.5, wasmLegFeeBps: 3.25,
  medianSlipBps: 3.25, p90SlipBps: 3.25,
  priceTracking: { depthWeightedAbsoluteDeviationBps: 3.25, within10Share: 0.375 },
  priceTrackingExcludingLtc: { depthWeightedAbsoluteDeviationBps: 3.25 }
};

function formattedMetrics(groups) {
  return groups.map(metrics => metrics.map(metric => {
    assert.equal(typeof metric.format, 'function', 'every rolling metric supplies its feature denomination');
    return metric.format(metric.value(sample));
  }));
}

test('ADR26 affiliate rolling metrics preserve dollars and bps; native pair epochs have no rolling metrics', async () => {
  const groups = await toolbarMetrics('DynamicFeeDashboard.svelte', [
    'formatUsd', 'formatNumber', 'formatBps', 'formatRateBps', 'affiliateRollingMean', 'affiliateRollingRate'
  ]);
  const result = formattedMetrics(groups);
  assert.equal(groups.length, 1);
  assert.deepEqual(result[0].slice(0, 2), ['$165,586', '$324.29']);
  assert.equal(result[0][2], '20 bps');
});

test('TC fee rolling metrics declare their distinct dollar and bps units', async () => {
  const groups = await toolbarMetrics('TCFeeDash.svelte', [], { formatUSD, formatBps: formatTcFeeBps });
  assert.deepEqual(formattedMetrics(groups), [['$1,235'], ['3.25 bps']]);
});

test('all five Wasm rolling charts retain USD, bps and correctly scaled percentage units', async () => {
  const groups = await toolbarMetrics('WasmArbEconomics.svelte', [
    'usd2', 'asFiniteNumber', 'formatUsd', 'formatPercent', 'formatBps'
  ]);
  assert.deepEqual(formattedMetrics(groups), [
    ['$1,234.50', '$1,234.50'],
    ['$1,234.50', '37.50%'],
    ['$1,234.50', '$1,234.50'],
    ['3.25 bps', '3.25 bps', '3.25 bps'],
    ['3.25 bps', '3.25 bps', '37.50%']
  ]);
});
