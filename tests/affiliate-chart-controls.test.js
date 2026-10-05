import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';

const source = name => readFile(new URL(`../src/lib/${name}`, import.meta.url), 'utf8');

test('affiliate timeframe shares the bucket/legend toolbar below the summary and above the plot', async () => {
  const dashboard = await source('DynamicFeeDashboard.svelte');
  const start = dashboard.indexOf('<LegacyChartTools chart={affiliateChartInstance}');
  const end = dashboard.indexOf('</LegacyChartTools>', start);
  const toolbar = dashboard.slice(start, end);
  assert.ok(start > dashboard.indexOf('<RangeSummary rows={affiliateSummaryRows}'));
  assert.ok(end < dashboard.indexOf('<div class="chart-frame affiliate-chart-frame">'));
  assert.match(toolbar, /slot="controls" class="affiliate-chart-control timeframe-control"/);
  assert.match(toolbar, /role="tablist" aria-label="Affiliate chart timeframe"/);
  assert.match(toolbar, /aria-selected=\{affiliateTimeframe === option.id\}/);
  assert.match(toolbar, /on:click=\{\(\) => setAffiliateTimeframe\(option.id\)\}/);
  assert.doesNotMatch(dashboard, /affiliate-chart-toolbar|affiliate-chart-view-controls/);
  assert.match(dashboard, /\.affiliate-chart-control \{[^}]*align-items: center;[^}]*flex-wrap: wrap;/);
  assert.match(dashboard, /\.timeframe-control \{\s*margin-left: auto;/);
});

test('legacy chart forwards optional inline controls without changing default toolbars', async () => {
  const legacy = await source('charts/LegacyChartTools.svelte');
  const tools = await source('charts/ChartTools.svelte');
  assert.match(legacy, /inlineControls=\{Boolean\(\$\$slots.controls\)\}/);
  assert.match(legacy, /<svelte:fragment slot="controls"><slot name="controls" \/><\/svelte:fragment>/);
  assert.match(tools, /export let inlineControls = false/);
  assert.match(tools, /<\/details>\s*<slot name="controls" \/>\s*<\/div>/);
  assert.match(tools, /\.with-controls details \{ flex: 0 1 auto; \}/);
  for (const component of [legacy, tools]) assert.doesNotThrow(() => compile(component, { generate: 'server' }));
});
