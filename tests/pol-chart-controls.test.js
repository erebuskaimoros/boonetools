import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const source = name => readFile(new URL(`../src/lib/${name}`, import.meta.url), 'utf8');
const switchSource = await source('components/terminal/CurrencySwitch.svelte');
const compiled = compile(switchSource, { generate: 'server' }).js.code
  .replace("'svelte/internal/server'", JSON.stringify(import.meta.resolve('svelte/internal/server')));
const { default: CurrencySwitch } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('currency switch renders its denomination as an accessible native button', () => {
  for (const unit of ['rune', 'usd']) {
    const { body } = render(CurrencySwitch, { props: { unit, ariaLabel: 'POL deposits in US dollars' } });
    assert.match(body, /<button type="button"[^>]*role="switch"/);
    assert.match(body, /aria-label="POL deposits in US dollars"/);
    assert.ok(body.includes(`aria-checked="${unit === 'usd'}"`));
    assert.doesNotMatch(body, / disabled/);
    assert.match(body, />RUNE<\/span>/);
    assert.match(body, />\$<\/span>/);
  }
});

test('unavailable dollar prices disable entry to USD but never prevent returning to RUNE', () => {
  const disabled = render(CurrencySwitch, { props: { unit: 'rune', usdAvailable: false } }).body;
  const escape = render(CurrencySwitch, { props: { unit: 'usd', usdAvailable: false } }).body;
  assert.match(disabled, / disabled/);
  assert.doesNotMatch(escape, / disabled/);
  assert.match(switchSource, /onChange\(unit === 'usd' \? 'rune' : 'usd'\)/);
  assert.match(switchSource, /button:focus-visible/);
  assert.match(switchSource, /prefers-reduced-motion: reduce/);
});

test('shared chart puts optional feature controls after its legend and immediately before the plot', async () => {
  const chart = await source('charts/TimeSeriesChart.svelte');
  assert.ok(chart.indexOf('<ChartTools') < chart.indexOf('<slot name="controls"'));
  assert.match(chart, /<slot name="controls" \/>\s*<div class="time-series-frame"/);
  assert.ok(chart.indexOf('<slot name="overlay"') > chart.indexOf('<div class="time-series-frame"'));
  const fees = await source('system-income-pol/DailyFeeChart.svelte');
  assert.match(fees, /<svelte:fragment slot="overlay">\s*\{#if selected/);
});

test('both POL toolbars move below summaries into the right-aligned plot control slot', async () => {
  for (const name of ['SystemIncomePOL.svelte', 'system-income-pol/DailyFeeChart.svelte']) {
    const component = await source(name);
    const toolbar = component.indexOf('<div slot="controls"');
    assert.ok(toolbar > component.indexOf('<RangeSummary'));
    assert.ok(toolbar > component.indexOf('<TimeSeriesChart'));
    assert.ok(toolbar < component.indexOf('</TimeSeriesChart>'));
    assert.match(component, /slot="controls"[^>]*role="group"/);
    assert.match(component.slice(toolbar, component.indexOf('</TimeSeriesChart>')), /<CurrencySwitch/);
    assert.match(component, /\.(?:chart-controls|controls) \{[^}]*justify-content: flex-end/);
    assert.doesNotMatch(component, /\.(?:chart-controls|controls) \{[^}]*justify-content: flex-start/);
    assert.doesNotMatch(component, />\[(?:RUNE|USD|\$)\]<\/button>/);
  }
});
