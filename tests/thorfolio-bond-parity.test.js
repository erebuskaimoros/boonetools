import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compile, parse } from 'svelte/compiler';
import { render } from 'svelte/server';
import * as bondHistory from '../src/lib/position-tracker/bond-history.js';
import { buildBondRows, churnEstimateInput } from '../src/lib/position-tracker/model.js';
import { estimateCurrentChurnYields } from '../src/lib/bond-tracker/apy.js';
import { calculateAPY } from '../src/lib/utils/calculations.js';

async function renderPanel(name, props) {
  const sourceUrl = new URL(`../src/lib/position-tracker/${name}.svelte`, import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const { js } = compile(source, { generate: 'server', filename: sourceUrl.pathname });
  const code = js.code.replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
    const resolved = specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier);
    return `from ${quote}${resolved}${quote}`;
  });
  const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return render(Component, { props }).body;
}

const rows = [
  { key: 'a:node1', address: 'thor1providerA', nodeAddress: 'thor1node1', bond: 1000, pendingReward: 10, apr: 0.1, apy: calculateAPY(0.1), operatorFee: 0.1, status: 'Active' },
  { key: 'b:node1', address: 'thor1providerB', nodeAddress: 'thor1node1', bond: 500, pendingReward: 5, apr: 0.2, apy: calculateAPY(0.2), operatorFee: 0.1, status: 'Active' },
  { key: 'b:node2', address: 'thor1providerB', nodeAddress: 'thor1node2', bond: 500, pendingReward: 3, apr: 0.3, apy: calculateAPY(0.3), operatorFee: 0.15, status: 'Standby' }
];
const history = [
  { runeStack: 1000e8, bondChange: 0, reward: 0, runePrice: 2 },
  { runeStack: 1520e8, bondChange: 500e8, reward: 20e8, runePrice: 3 },
  { runeStack: 1440e8, bondChange: -100e8, reward: 20e8, runePrice: 4 }
];

test('Node Bonds starts collapsed and exposes its table when expanded', async () => {
  const props = { rows, hasThor: true, loadedOnce: true };
  const collapsed = await renderPanel('BondPanel', props);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /<table\b/);
  assert.match(collapsed, /bond to node/);
  const expanded = await renderPanel('BondPanel', { ...props, expanded: true });
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /<table\b/);
  assert.match(expanded, /thor1node1/);
});

test('node details preserve fractional operator fees and a measured zero APY', async () => {
  const html = await renderPanel('BondPanel', {
    rows: [{ ...rows[0], operatorFee: 0.105, apy: 0 }], hasThor: true, loadedOnce: true, expanded: true
  });
  assert.match(html, /10\.5%/);
  assert.match(html, />0\.0%<\/td>/);
});

test('combined APY matches Bond Tracker annualization of total awards and principal', () => {
  const churnState = { lastChurnHeight: 100, nextChurnHeight: 43300, currentHeight: 21700, secondsPerBlock: 6 };
  const nodes = [20, 200].map((award, index) => ({
    node_address: `node${index}`, status: 'Active', current_award: String(award * 1e8),
    bond_providers: { node_operator_fee: '1000', providers: [{ bond_address: 'provider', bond: String(100000e8) }] }
  }));
  const liveRows = buildBondRows({ nodes, addresses: ['provider'], churnState });
  const expected = estimateCurrentChurnYields({ principal: 200000, reward: 198, ...churnEstimateInput(churnState) }).apy;
  const summary = bondHistory.summarizeBondMetrics(liveRows, []);
  assert.ok(Math.abs(summary.apy - expected) < 1e-10, `combined APY ${summary.apy} differs from classic ${expected}`);
  assert.ok(Math.abs(summary.annualRewardRune - expected * 200000) < 1e-5);
});

test('Bond History retains a refresh action beside its chart', async () => {
  const source = await readFile(new URL('../src/lib/position-tracker/BondHistory.svelte', import.meta.url), 'utf8');
  const ast = parse(source);
  let found = false;
  function visit(node, inActions = false) {
    const actions = inActions || node.attributes?.some((attribute) => attribute.name === 'class'
      && attribute.value?.some((part) => part.type === 'Text' && part.data.split(/\s+/).includes('block-actions')));
    if (actions && node.type === 'Element' && node.name === 'button'
      && /refresh/i.test(source.slice(node.start, node.end))) found = true;
    for (const child of node.children || []) visit(child, actions);
  }
  visit(ast.html);
  assert.ok(found, 'chart refresh must be reachable without scrolling to the page header');
});

test('bond summary compounds bond-weighted APR and counts unique nodes', () => {
  assert.equal(typeof bondHistory.summarizeBondMetrics, 'function');
  const summary = bondHistory.summarizeBondMetrics(rows, history);
  assert.equal(summary.bondRune, 2000);
  assert.equal(summary.pendingRewardRune, 18);
  const expectedApy = Math.pow(1 + 0.175 / 365, 365) - 1;
  assert.equal(summary.apr, 0.175);
  assert.equal(summary.apy, expectedApy);
  assert.equal(summary.annualRewardRune, 2000 * expectedApy);
  assert.equal(summary.nodeCount, 2, 'two tracked providers can share one node');
  assert.equal(summary.totalRewardsRune, 40, 'deposits are not earnings');
  assert.equal(summary.totalRewardsUsd, 140, 'value rewards at their own churn price');
  assert.equal(summary.netBondChangeRune, 400);
  assert.equal(summary.rewardPercent, 4);
});

test('single-node and empty summaries retain usable fee and zero states', () => {
  assert.equal(typeof bondHistory.summarizeBondMetrics, 'function');
  const single = bondHistory.summarizeBondMetrics(rows.slice(0, 2), []);
  assert.equal(single.nodeCount, 1);
  assert.equal(single.nodeFee, 0.1);
  const empty = bondHistory.summarizeBondMetrics([], []);
  for (const field of ['bondRune', 'pendingRewardRune', 'apy', 'annualRewardRune', 'nodeCount', 'totalRewardsRune', 'totalRewardsUsd', 'netBondChangeRune']) {
    assert.equal(empty[field], 0, field);
  }
});

test('Bond tab restores all eight tracker metric cards above the history plot', async () => {
  const html = await renderPanel('BondMetrics', {
    rows, history, loaded: true, loadedOnce: true, runePriceUsd: 2,
    money: (value) => `$${value}`, nextChurnIn: '2d', churnHalted: true
  });
  for (const label of ['bond ᚱ', 'next award ᚱ', 'total earned ᚱ', 'net bond/unbond', 'apy', 'rune price', 'next churn', 'nodes']) {
    assert.ok(html.toLowerCase().includes(label), `missing ${label}`);
  }
  assert.match(html, /19\.12%/);
  assert.match(html.toLowerCase(), /halted/);
});

test('Bond history exposes the same native and calendar chart tools as Bond Tracker', async () => {
  const source = await readFile(new URL('../src/lib/position-tracker/BondHistory.svelte', import.meta.url), 'utf8');
  assert.match(source, /<EventTimeSeriesChart\b/);
  assert.match(source, /bind:hidden=/, 'native and calendar legends must share visibility');
  assert.match(source, /refreshKey/, 'refreshing the dashboard must also reload its history');
});

test('Bond History provides the shared currency selector in its own header controls', async () => {
  const source = await readFile(new URL('../src/lib/position-tracker/BondHistory.svelte', import.meta.url), 'utf8');
  const ast = parse(source);
  let selectorInHeader = false;
  function visit(node, inHeader = false) {
    const header = inHeader || node.attributes?.some((attribute) => attribute.name === 'class'
      && attribute.value?.some((part) => part.type === 'Text' && part.data.split(/\s+/).includes('block-actions')));
    if (node.type === 'InlineComponent' && node.name === 'CurrencySelector' && header) selectorInHeader = true;
    for (const child of node.children || []) visit(child, header);
  }
  visit(ast.html);
  assert.ok(selectorInHeader, 'currency selection must be available beside Bond History without scrolling to the page header');
  assert.ok(ast.instance.content.body.some((node) => node.type === 'ImportDeclaration'
    && node.source.value.endsWith('/components/CurrencySelector.svelte')), 'reuse the selector bound to the page currency store');
});
