import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { compile, parse } from 'svelte/compiler';
import { render } from 'svelte/server';
import { searchTools, isNavigationSearchShortcut } from '../src/lib/navigation/search.js';

const appSource = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
const registry = parse(appSource).instance.content.body.filter(node =>
  node.type === 'VariableDeclaration' && node.kind === 'const' && node.declarations.some(({ id }) =>
    /App$/.test(id.name) || id.name === 'apps')
).map(node => appSource.slice(node.start, node.end)).join('\n');
const apps = Array.from(runInNewContext(`${registry}; apps;`, { SHOW_LIMIT_ORDERS: false, SHOW_VOTE_TRACKER: true }));
const paths = query => searchTools(apps, query).map(app => app.path);

test('empty search preserves navigation order and only public production tools', () => {
  for (const query of ['', '   ', '---']) assert.deepEqual(paths(query), apps.map(app => app.path));
  assert.equal(apps.length, 16);
  for (const hidden of ['bond-tracker', 'wasm-arb-economics', 'limit-orders']) {
    assert.equal(paths(hidden).includes(hidden), false);
  }
});

test('page search prioritizes names, normalizes punctuation/case, and handles typos', () => {
  for (const [query, expected] of [
    ['POOL ANALYSIS', 'pool-analysis'], [' pool--analysis ', 'pool-analysis'],
    ['pool anal', 'pool-analysis'], ['financals', 'financials'], ['finanicals', 'financials'],
    ['thorflio', 'thorfolio'], ['trsy', 'treasury'], ['tcfd', 'tc-fee-dash'],
    ['portfolio', 'thorfolio'], ['pol tracker', 'pol-tracker'], ['vault', 'vault-explorer']
  ]) assert.equal(paths(query)[0], expected, query);
});

test('descriptive topics work, multiword searches require every term, and nonsense is empty', () => {
  assert.ok(paths('tcy').includes('thorfolio'));
  assert.ok(paths('mimir').includes('vote-tracker'));
  assert.ok(paths('system income').includes('financials'));
  assert.ok(paths('pool fees').includes('pool-analysis'));
  for (const query of ['zzzzzz', 'pool zzzzzzz', '<script>alert(1)</script>', 'x'.repeat(500)]) assert.deepEqual(paths(query), []);
  assert.deepEqual(paths('pool'), paths('pool'));
});

test('matching never loads dashboards or mutates the supplied catalog', () => {
  const catalog = Object.freeze([Object.freeze({ name: 'Example', path: 'example', description: 'Only a test',
    component: () => { throw new Error('Search must not load dashboards'); } })]);
  assert.equal(searchTools(catalog, 'exmple')[0], catalog[0]);
  assert.notEqual(searchTools(catalog, ''), catalog);
});

test('keyboard shortcut guards preserve typing, modifiers and composing text', () => {
  assert.equal(isNavigationSearchShortcut({ key: '/' }), true);
  assert.equal(isNavigationSearchShortcut({ key: 'k', ctrlKey: true }), true);
  assert.equal(isNavigationSearchShortcut({ key: 'K', metaKey: true }), true);
  for (const properties of [{ defaultPrevented: true }, { isComposing: true }, { repeat: true },
    { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { target: { closest: () => ({}) } }]) {
    assert.equal(isNavigationSearchShortcut({ key: '/', ...properties }), false);
  }
  assert.equal(isNavigationSearchShortcut({ key: 'k' }), false);
});

const navSource = readFileSync(new URL('../src/lib/navigation/ToolNavigation.svelte', import.meta.url), 'utf8');
const compiled = compile(navSource, { generate: 'server' }).js.code
  .replace("'svelte/internal/server'", JSON.stringify(import.meta.resolve('svelte/internal/server')))
  .replace("'./search.js'", JSON.stringify(import.meta.resolve('../src/lib/navigation/search.js')));
const { default: Navigation } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('desktop and mobile navigation expose labeled search, ranked results, and the active page', () => {
  for (const mobile of [false, true]) {
    const html = render(Navigation, { props: { apps, query: 'financals', activePath: 'financials', mobile } }).body;
    assert.match(html, /type="search" aria-label="Search pages"/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /1 page found/);
    assert.match(html, /financials/);
    assert.doesNotMatch(html, />pool-analysis</);
  }
});

test('collapsed navigation stays complete and provides an expand-search button', () => {
  const html = render(Navigation, { props: { apps, compact: true, query: 'fees' } }).body;
  assert.match(html, /aria-label="Search pages"/);
  assert.doesNotMatch(html, /<input/);
  assert.equal((html.match(/class="tool-item/g) || []).length, 16);
});

test('idle navigation omits the shortcut hint and its status row on desktop and mobile', () => {
  for (const mobile of [false, true]) {
    const html = render(Navigation, { props: { apps, mobile } }).body;
    assert.doesNotMatch(html, /Ctrl\/Cmd\+K to search|class="search-note/);
    assert.match(html, /aria-label="Search pages"/);
    assert.equal((html.match(/class="tool-item/g) || []).length, 16);
  }
});

test('empty results are clear and user input is escaped', () => {
  const html = render(Navigation, { props: { apps, query: '<img src=x onerror=alert(1)>' } }).body;
  assert.match(html, /0 pages found/);
  assert.match(html, /No pages match/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /Clear page search/);
});
