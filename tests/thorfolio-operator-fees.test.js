import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { buildChurnHistory } from '../src/lib/position-tracker/bond-history.js';

async function componentUrl(url) {
  // Currency selection is covered separately; its legacy icon barrel is Vite-only.
  if (url.pathname.endsWith('/CurrencySelector.svelte')) return 'data:text/javascript,export default function(){}';
  let source = await readFile(url, 'utf8');
  // Exercise the real renderer with supplied snapshots, without starting HTTP acquisition.
  if (url.pathname.endsWith('/BondHistory.svelte')) source = source.replace('$: load(addressKey, includeHistorical, refreshKey);', '');
  const { js } = compile(source, { generate: 'server', filename: url.pathname });
  let code = js.code;
  for (const [statement, quote, specifier] of js.code.matchAll(/from (['"])([^'"]+)\1/g)) {
    const local = specifier.startsWith('$lib/') ? new URL(`../src/lib/${specifier.slice(5)}`, import.meta.url)
      : specifier.startsWith('.') ? new URL(specifier, url) : null;
    if (local && !/\.[a-z]+$/i.test(local.pathname)) local.pathname += '.js';
    const resolved = specifier.endsWith('.svelte') ? await componentUrl(local) : local ? local.href : import.meta.resolve(specifier);
    code = code.replace(statement, `from ${quote}${resolved}${quote}`);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const { default: Component } = await import(await componentUrl(new URL('../src/lib/position-tracker/BondHistory.svelte', import.meta.url)));
const history = (fee) => buildChurnHistory([{ churn_height: 100, churn_timestamp: 1750000000,
  rune_stack: 1010e8, user_bond: 1000e8, rune_price: 1, operator_fee: fee }]);
const html = (props) => render(Component, { props }).body;

test('churn table hides operator fees for provider-only portfolios', () => {
  assert.doesNotMatch(html({ history: history(0) }), /operator fee ᚱ/);
});

test('current and historical operators get the fee column, including zero and unavailable states', () => {
  assert.match(html({ history: history(12.34e8) }), /operator fee ᚱ/);
  assert.match(html({ history: history(12.34e8) }), /\+12\.34/);
  assert.match(html({ history: history(0), hasOperator: true }), /operator fee ᚱ/);
  const unknown = html({ history: history(null), hasOperator: true });
  assert.match(unknown, /title="Payout not yet verified">—<\/td>/);
  assert.match(unknown, /separate from bond rewards and stack/);
});
