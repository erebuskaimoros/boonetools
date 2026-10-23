import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const source = name => readFile(new URL(`../src/lib/${name}`, import.meta.url), 'utf8');
function compileUrl(text, replacements = {}) {
  let compiled = compile(text, { generate: 'server' }).js.code
    .replace("'svelte/internal/server'", JSON.stringify(import.meta.resolve('svelte/internal/server')));
  for (const [from, to] of Object.entries(replacements)) compiled = compiled.replace(JSON.stringify(from), JSON.stringify(to)).replace(`'${from}'`, JSON.stringify(to));
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
const controlSource = await source('tc-fee-dash/FeeShareRollingControl.svelte');
const { default: Control } = await import(compileUrl(controlSource));
const { default: Tools } = await import(compileUrl(await source('charts/ChartTools.svelte'), {
  './SeriesLegend.svelte': compileUrl(await source('charts/SeriesLegend.svelte')),
  './analytics.js': import.meta.resolve('../src/lib/charts/analytics.js')
}));

test('fee share menu has only exclusive 7D/30D choices with a clear-to-raw state', () => {
  for (const value of [0, 7, 30]) {
    const body = render(Control, { props: { value } }).body;
    const inputs = body.match(/<input\b[^>]*>/g);
    assert.equal(inputs.length, 2);
    assert.equal(inputs.filter(input => /\bchecked\b/.test(input)).length, value ? 1 : 0);
    for (const days of [7, 30]) assert.equal(/\bchecked\b/.test(inputs.find(input => input.includes(`${days}-day fee share average`))), value === days);
    assert.doesNotMatch(body, /90-day|BTC|ETH|STABLECOINS|OTHER/);
    assert.match(body, /Clear it to restore/);
  }
  assert.match(controlSource, /value = value === days \? 0 : days/);
  assert.match(controlSource, /event.key === 'Escape'/);
  assert.match(controlSource, /trigger\?\.focus\(\)/);
});

test('shared toolbar retains legacy overlays by default and allows a static composition key', () => {
  const series = [{ id: 'btc', label: 'BTC', mark: 'line', color: '#d4a017' }];
  const normal = render(Tools, { props: { series } }).body;
  assert.equal((normal.match(/<input\b/g) || []).length, 3);
  assert.match(normal, /90-day average BTC/);
  assert.match(normal, /<button[^>]*aria-pressed="true"[^>]*>[^]*BTC<\/button>/);
  const composition = render(Tools, { props: { series, showRollingControls: false, interactiveLegend: false } }).body;
  assert.doesNotMatch(composition, /<input\b|ROLLING AVGS/);
  assert.match(composition, /class="series-label/);
});

test('only the composition opts out of generic overlays and keeps its custom control in the toolbar', async () => {
  const component = await source('tc-fee-dash/PoolFeeShareChart.svelte');
  assert.match(component, /showRollingControls=\{false\} interactiveLegend=\{false\}/);
  assert.match(component, /<FeeShareRollingControl slot="legend-extra" bind:value=\{smoothingDays\}/);
  assert.match(component, /feeHistory: history/);
  const shared = await source('charts/TimeSeriesChart.svelte');
  assert.match(shared, /export let showRollingControls = true/);
  assert.match(shared, /export let interactiveLegend = true/);
});
