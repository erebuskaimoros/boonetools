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
});
