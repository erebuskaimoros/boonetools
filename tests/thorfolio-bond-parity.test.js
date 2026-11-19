import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compile, parse } from 'svelte/compiler';
import { render } from 'svelte/server';
import * as bondHistory from '../src/lib/position-tracker/bond-history.js';
import { buildBondRows, churnEstimateInput } from '../src/lib/position-tracker/model.js';
import { estimateCurrentChurnYields } from '../src/lib/bond-tracker/apy.js';
import { createBondRewardLoader, currentChurnRewardFraction, heightCheckedFetch } from '../src/lib/position-tracker/bond-rewards.js';
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
  const liveRows = buildBondRows({ nodes, addresses: ['provider'], churnState,
    bondRewardContext: { lastChurnHeight: 100, currentBondRewardRune: '22000000000', carryoverBondRewardRune: '0' }
  });
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

test('Thorfolio excludes carried-over bond rewards from yield but preserves the full pending award', () => {
  const churnState = { lastChurnHeight: 100, nextChurnHeight: 43300, currentHeight: 21700, secondsPerBlock: 6 };
  const nodes = [{
    node_address: 'node', status: 'Active', current_award: String(1000e8),
    bond_providers: { node_operator_fee: '1000', providers: [{ bond_address: 'provider', bond: String(100000e8) }] }
  }];
  const [row] = buildBondRows({ nodes, addresses: ['provider'], churnState,
    bondRewardContext: { lastChurnHeight: 100, currentBondRewardRune: '100000000000', carryoverBondRewardRune: '80000000000' }
  });
  const expected = estimateCurrentChurnYields({ principal: 100000, reward: 180, ...churnEstimateInput(churnState) });
  assert.equal(row.pendingReward, 900);
  assert.ok(Math.abs(row.apr - expected.apr) < 1e-10, 'APR must annualize only newly accrued rewards');
  assert.ok(Math.abs(row.apy - expected.apy) < 1e-10, 'APY must exclude the 80% carried-over pool balance');
});


test('reward fraction rejects missing, malformed and mismatched baselines and supports zero fresh income', () => {
  const state = { lastChurnHeight: 100 };
  const valid = { lastChurnHeight: 100, currentBondRewardRune: '1000', carryoverBondRewardRune: '800' };
  assert.equal(currentChurnRewardFraction(valid, state), 0.2);
  for (const context of [null, { ...valid, lastChurnHeight: 99 }, { ...valid, currentBondRewardRune: null },
    { ...valid, carryoverBondRewardRune: '-1' }, { ...valid, carryoverBondRewardRune: 'NaN' }, { ...valid, currentBondRewardRune: '700' }]) {
    assert.equal(currentChurnRewardFraction(context, state), null);
  }
  assert.equal(currentChurnRewardFraction({ ...valid, currentBondRewardRune: '800' }, state), 0);
  assert.equal(currentChurnRewardFraction({ ...valid, currentBondRewardRune: '0', carryoverBondRewardRune: '0' }, state), 0);
});

test('carryover exclusion retains operator fees and full pending rewards, with unavailable yields on missing context', () => {
  const churnState = { lastChurnHeight: 100, nextChurnHeight: 43300, currentHeight: 21700, secondsPerBlock: 6 };
  const nodes = [{ node_address: 'node', node_operator_address: 'operator', status: 'Active', current_award: String(1000e8),
    bond_providers: { node_operator_fee: '1000', providers: [
      { bond_address: 'operator', bond: String(10000e8) }, { bond_address: 'provider', bond: String(90000e8) }
    ] } }];
  const input = { nodes, addresses: ['operator', 'provider'], churnState };
  const corrected = buildBondRows({ ...input, bondRewardContext: {
    lastChurnHeight: 100, currentBondRewardRune: '1000', carryoverBondRewardRune: '800'
  } });
  const operator = corrected.find((row) => row.isOperator);
  assert.equal(operator.pendingReward, 190);
  const expected = estimateCurrentChurnYields({ principal: 10000, reward: 38, ...churnEstimateInput(churnState) });
  assert.ok(Math.abs(operator.apy - expected.apy) < 1e-10);
  const unavailable = buildBondRows(input);
  assert.ok(unavailable.every((row) => row.apr === null && row.apy === null));
  const summary = bondHistory.summarizeBondMetrics(unavailable);
  assert.equal(summary.pendingRewardRune, 1000);
  assert.equal(summary.bondRune, 100000);
  assert.equal(summary.apy, null);
  assert.equal(summary.annualRewardRune, null);
});

test('reward loader pins observations, caches only the churn baseline and switches baselines after churn', async () => {
  const networkCalls = [];
  const vaultCalls = [];
  let churnHeight = 100;
  const load = createBondRewardLoader(async (height) => {
    networkCalls.push(height);
    return { bond_reward_rune: height === churnHeight ? '800' : '1000' };
  }, async (height) => {
    vaultCalls.push(height);
    return [{ status: 'ActiveVault', status_since: churnHeight }];
  });
  const state = { lastChurnHeight: 100, currentHeight: 200 };
  const first = await load(state);
  assert.equal(currentChurnRewardFraction(first, state), 0.2);
  await load({ ...state, currentHeight: 201 });
  assert.equal(networkCalls.filter((height) => height === 100).length, 1);
  assert.ok(networkCalls.includes(200) && networkCalls.includes(201));
  assert.deepEqual(vaultCalls, [200, 201]);
  churnHeight = 300;
  await load({ lastChurnHeight: 300, currentHeight: 400 });
  assert.ok(networkCalls.includes(400) && networkCalls.includes(300));
  assert.equal(await load({ lastChurnHeight: 100, currentHeight: 401 }), null, 'stale churn clock must not use new-cycle awards');
});

test('reward loader retries failed or invalid baseline reads without caching a false zero', async () => {
  for (const failure of ['throw', 'invalid']) {
    let baselineAttempts = 0;
    const load = createBondRewardLoader(async (height) => {
      if (height === 100 && ++baselineAttempts === 1) {
        if (failure === 'throw') throw new Error('rate limited');
        return {};
      }
      return { bond_reward_rune: height === 100 ? '800' : '1000' };
    }, async () => [{ status: 'ActiveVault', status_since: 100 }]);
    const state = { lastChurnHeight: 100, currentHeight: 200 };
    assert.equal(await load(state), null);
    assert.equal(currentChurnRewardFraction(await load(state), state), 0.2);
    assert.equal(baselineAttempts, 2);
  }
});


test('height verification requires exact exposed metadata and preserves the response for pending balances', async () => {
  for (const observed of [null, '201', '200', 'garbage']) {
    let verified;
    const response = new Response('{}', { headers: observed == null ? {} : { 'grpc-metadata-x-cosmos-block-height': observed } });
    const fetchPinned = heightCheckedFetch(200, (value) => { verified = value; }, async () => response);
    assert.equal(await fetchPinned('/thorchain/nodes'), response);
    assert.equal(verified, observed === '200');
  }
});
