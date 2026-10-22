import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'svelte/compiler';

const A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const source = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
const routing = parse(source).instance.content.body.filter((node) =>
  (node.type === 'VariableDeclaration' && node.kind === 'const' && node.declarations.some(({ id }) =>
    /App$/.test(id.name) || ['apps', 'hiddenApps', 'routeAliases'].includes(id.name))) ||
  (node.type === 'FunctionDeclaration' && ['stripBase', 'getAvailableApp', 'canonicalizeAliasUrl'].includes(node.id.name))
).map((node) => source.slice(node.start, node.end)).join('\n');

// Exercise the app registry and URL handling used by initial load and popstate.
function resolve(href, { base = '' } = {}) {
  const location = new URL(href);
  const replacements = [];
  const history = { replaceState(_state, _title, next) {
    location.href = new URL(next, location).href;
    replacements.push(location.href);
  } };
  const result = runInNewContext(`${routing}
    const route = stripBase(window.location.pathname).slice(1).split('/')[0];
    const app = getAvailableApp(route);
    if (app) canonicalizeAliasUrl(route, app);
    ({ app, visiblePaths: apps.map(app => app.path) });`, {
    BASE_PATH: base, SHOW_LIMIT_ORDERS: false, SHOW_VOTE_TRACKER: true,
    history, window: { location, history }
  });
  return { ...result, location, replacements };
}

test('old bond links open the standalone tracker without rewriting their address or options', () => {
  const href = `https://boone.tools/bond-tracker?bond_address=${A}&node_address=${B}&currency=EUR&source=desktop-app#history`;
  const { app, location, replacements } = resolve(href);
  assert.equal(app.path, 'bond-tracker');
  assert.match(app.component.toString(), /BondTrackerV2\.svelte/);
  assert.equal(location.href, href);
  assert.equal(replacements.length, 0);
});

test('the standalone tracker resolves without an address and under a base path', () => {
  for (const base of ['', '/tools']) {
    for (const search of ['', `?bond_address=${A}&currency=GBP`]) {
      const href = `https://boone.tools${base}/bond-tracker${search}`;
      const { app, location, replacements } = resolve(href, { base });
      assert.equal(app.path, 'bond-tracker');
      assert.equal(location.href, href);
      assert.equal(replacements.length, 0);
    }
  }
});

test('the classic alias still opens the standalone tracker and preserves all URL state', () => {
  for (const base of ['', '/tools']) {
    const search = `?bond_address=${A}&node_address=${B}&currency=EUR&source=desktop-app`;
    const { app, location, replacements } = resolve(`https://boone.tools${base}/bond-tracker-classic${search}#history`, { base });
    assert.equal(app.path, 'bond-tracker');
    assert.equal(location.href, `https://boone.tools${base}/bond-tracker${search}#history`);
    assert.equal(replacements.length, 1);
  }
});

test('Thorfolio keeps its own multi-address URL and remains the only tracker in navigation', () => {
  const href = `https://boone.tools/thorfolio?addresses=${A}%2C${B}&tab=tcy&currency=EUR#history`;
  const { app, location, replacements, visiblePaths } = resolve(href);
  assert.equal(app.path, 'thorfolio');
  assert.match(app.component.toString(), /PositionTracker\.svelte/);
  assert.equal(location.href, href);
  assert.equal(replacements.length, 0);
  assert.equal(visiblePaths.includes('thorfolio'), true);
  assert.equal(visiblePaths.some(path => path.startsWith('bond-tracker')), false);
});
