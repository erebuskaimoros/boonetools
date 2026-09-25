import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Cross-chain Competitors hides unavailable buckets and the source-resolution note without changing other charts', async () => {
  const read = file => readFile(new URL(`../src/lib/${file}`, import.meta.url), 'utf8');
  const [panel, chart, host, tools] = await Promise.all([
    read('protocol-fee-comparison/Comparison.svelte'), read('protocol-fee-comparison/Chart.svelte'),
    read('charts/TimeSeriesChart.svelte'), read('charts/ChartTools.svelte')
  ]);
  assert.match(panel, /id="comparison-title"[^\n]*Cross-chain Competitors/);
  assert.match(chart, /hideUnavailableGrains showSourceResolution=\{false\}/);
  assert.match(chart, /initialGrain="month"/);
  assert.match(host, /export let hideUnavailableGrains = false/);
  assert.match(host, /export let showSourceResolution = true/);
  assert.match(host, /<ChartTools[^>]*\{hideUnavailableGrains\} \{showSourceResolution\}/);
  assert.match(tools, /!hideUnavailableGrains \|\| grainAvailable\(value, sourceGrain\)/);
  assert.match(tools, /#if showSourceResolution && sourceGrain !== 'day'/);
});
