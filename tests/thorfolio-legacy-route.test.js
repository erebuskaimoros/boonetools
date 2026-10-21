import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'svelte/compiler';
import { loadTrackedAddresses, STORAGE_KEY } from '../src/lib/position-tracker/addresses.js';

const A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const source = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
const handler = parse(source).instance.content.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'canonicalizeAliasUrl');

// Exercise the same URL rewrite used on first load and browser back/forward.
function redirect(href, { base = '', route = 'bond-tracker', destination = 'thorfolio' } = {}) {
  const location = new URL(href);
  const replacements = [];
  const history = { replaceState(_state, _title, next) {
    location.href = new URL(next, location).href;
    replacements.push(location.href);
  } };
  const rewrite = runInNewContext(`${source.slice(handler.start, handler.end)}; canonicalizeAliasUrl`, {
    BASE_PATH: base, URL, URLSearchParams, history,
    positionTrackerApp: { path: 'thorfolio' },
    window: { location, history }
  });
  rewrite(route, { path: destination });
  return { location, replacements };
}

test('old bond address links become an explicit Thorfolio address URL with currency and fragment intact', () => {
  const { location, replacements } = redirect(`https://boone.tools/bond-tracker?bond_address=${A}&node_address=${B}&currency=EUR&source=desktop-app#history`);
  assert.equal(location.pathname, '/thorfolio');
  assert.equal(location.searchParams.get('addresses'), A);
  assert.equal(location.searchParams.has('bond_address'), false);
  assert.equal(location.searchParams.has('node_address'), false);
  assert.equal(location.searchParams.get('tab'), 'bond');
  assert.equal(location.searchParams.get('currency'), 'EUR');
  assert.equal(location.searchParams.get('source'), 'desktop-app');
  assert.equal(location.hash, '#history');
  assert.equal(replacements.length, 1);
});

test('the forwarded portfolio contains the linked address instead of merging a saved portfolio', () => {
  const { location } = redirect(`https://boone.tools/bond-tracker?bond_address=${A}`);
  const fullPortfolio = Array.from({ length: 25 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, '0')}` }));
  for (const saved of [[{ address: B, label: 'saved' }], fullPortfolio]) {
    const tracked = loadTrackedAddresses({
      search: location.search,
      storage: { getItem: (key) => key === STORAGE_KEY ? JSON.stringify(saved) : null }
    });
    assert.deepEqual(tracked.map((entry) => entry.address), [A]);
  }
});

test('an explicit new address list and selected tab take precedence over legacy parameters', () => {
  const { location } = redirect(`https://boone.tools/bond-tracker?addresses=${A}%2C${B}&bond_address=${B}&tab=tcy`);
  assert.equal(location.searchParams.get('addresses'), `${A},${B}`);
  assert.equal(location.searchParams.get('tab'), 'tcy');
  assert.equal(location.searchParams.has('bond_address'), false);
});

test('legacy links work under the configured base path and without an address', () => {
  const { location } = redirect(`https://boone.tools/tools/bond-tracker?bond_address=${A}`, { base: '/tools' });
  assert.equal(location.pathname, '/tools/thorfolio');
  assert.equal(location.searchParams.get('addresses'), A);
  const empty = redirect('https://boone.tools/bond-tracker?currency=GBP').location;
  assert.equal(empty.pathname, '/thorfolio');
  assert.equal(empty.searchParams.has('addresses'), false);
  assert.equal(empty.searchParams.get('currency'), 'GBP');
});

test('canonical and classic tracker routes are left untouched', () => {
  for (const route of ['thorfolio', 'bond-tracker-classic']) {
    const href = `https://boone.tools/${route}?bond_address=${A}&tab=tcy#history`;
    const { location, replacements } = redirect(href, { route, destination: route });
    assert.equal(location.href, href);
    assert.equal(replacements.length, 0);
  }
});
