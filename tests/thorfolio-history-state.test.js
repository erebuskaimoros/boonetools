import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { combineChurnHistories, mergeBondTxMaps } from '../src/lib/position-tracker/bond-history.js';

const source = readFileSync(new URL('../src/lib/position-tracker/BondHistory.svelte', import.meta.url), 'utf8');
const handlers = parse(source).instance.content.body
  .filter((statement) => !['ImportDeclaration', 'LabeledStatement'].includes(statement.type))
  .map((statement) => source.slice(statement.start, statement.end).replace(/^export /, ''))
  .join('\n');

function createHistory({ writeText, currency = 'USD' } = {}) {
  const requests = [];
  const panel = runInNewContext(`${handlers}\n({
    load, copyLink,
    addresses(value) { addresses = value; },
    page(number) { page = number; },
    state() { return { history, loading, loaded, error, page, hasHistorical, copyState, shareUrl }; }
  })`, {
    URL, window: { location: { href: 'http://localhost:5174/thorfolio?addresses=thor1old&currency=USD#old' } },
    navigator: { clipboard: { writeText } }, $currentCurrency: currency,
    combineChurnHistories, mergeBondTxMaps,
    loadBondHistory(address, options) {
      return new Promise((resolve, reject) => requests.push({ address, options, resolve, reject }));
    },
    createEventDispatcher: () => () => {}, onDestroy() {}
  });
  return { panel, requests };
}

const snapshot = (height) => ({
  history: [{ height, timestampSec: height, runeStack: height * 1e8 }],
  txMap: {}, hasHistorical: true
});

test('switching the history address clears the old metrics and pagination before the response', async () => {
  const { panel, requests } = createHistory();
  const initial = panel.load('thor1first', false, 0);
  assert.equal(requests[0].options.fresh, false, 'initial history loads may reuse the cache');
  requests[0].resolve(snapshot(1));
  await initial;
  panel.page(4);
  const next = panel.load('thor1second', false, 0);
  assert.equal(panel.state().history.length, 0);
  assert.equal(panel.state().loaded, false);
  assert.equal(panel.state().loading, true);
  assert.equal(panel.state().page, 1);
  requests[1].resolve(snapshot(2));
  await next;
  assert.equal(panel.state().history[0].height, 2);
});

test('refresh retains the current history and page while replacing it in the background', async () => {
  const { panel, requests } = createHistory();
  const initial = panel.load('thor1first', false, 0);
  requests[0].resolve(snapshot(1));
  await initial;
  panel.page(3);
  const refresh = panel.load('thor1first', false, 1);
  assert.equal(requests[1].options.fresh, true, 'explicit refresh must bypass the ten-minute history cache');
  assert.equal(panel.state().history[0].height, 1);
  assert.equal(panel.state().loaded, true);
  assert.equal(panel.state().page, 3);
  requests[1].resolve(snapshot(2));
  await refresh;
  assert.equal(panel.state().history[0].height, 2);
});

test('mounting with an existing refresh counter reuses cache, then a changed counter bypasses it', async () => {
  const { panel, requests } = createHistory();
  const initial = panel.load('thor1first', false, 7);
  assert.equal(requests[0].options.fresh, false);
  requests[0].resolve(snapshot(1));
  await initial;
  const refresh = panel.load('thor1first', false, 8);
  assert.equal(requests[1].options.fresh, true);
  requests[1].resolve(snapshot(2));
  await refresh;
  const nextAddress = panel.load('thor1second', false, 9);
  assert.equal(requests[2].options.fresh, false, 'new address scope can reuse its own cached history');
  assert.equal(panel.state().hasHistorical, false, 'new address must not inherit historical-node availability');
  requests[2].resolve(snapshot(3));
  await nextAddress;
});

test('historical-node scope changes clear the old series and reset pagination', async () => {
  const { panel, requests } = createHistory();
  const initial = panel.load('thor1first', false, 0);
  requests[0].resolve(snapshot(1));
  await initial;
  panel.page(3);
  const historical = panel.load('thor1first', true, 0);
  assert.equal(requests[1].options.fresh, false, 'switching historical scope may reuse its own cache');
  assert.equal(panel.state().history.length, 0);
  assert.equal(panel.state().page, 1);
  requests[1].resolve(snapshot(2));
  await historical;
});

test('a failed background refresh retains the last successful history and historical-node toggle', async () => {
  const { panel, requests } = createHistory();
  const initial = panel.load('thor1first', false, 0);
  requests[0].resolve(snapshot(1));
  await initial;
  panel.page(3);
  const refresh = panel.load('thor1first', false, 1);
  requests[1].reject(new Error('Provider unavailable'));
  await refresh;
  assert.equal(panel.state().history[0]?.height, 1);
  assert.equal(panel.state().page, 3);
  assert.equal(panel.state().hasHistorical, true);
  assert.equal(panel.state().loading, false);
  assert.match(panel.state().error, /Provider unavailable/);
});

test('failed historical-node requests leave their toggle available for returning to current nodes', async () => {
  const { panel, requests } = createHistory();
  const initial = panel.load('thor1first', false, 0);
  requests[0].resolve(snapshot(1));
  await initial;
  const historical = panel.load('thor1first', true, 0);
  requests[1].reject(new Error('History unavailable'));
  await historical;
  assert.equal(panel.state().hasHistorical, true);
  assert.equal(panel.state().history.length, 0, 'never show current-only history in historical scope');
});

test('clearing the scope stops loading and invalidates an earlier request', async () => {
  const { panel, requests } = createHistory();
  const pending = panel.load('thor1first', false, 0);
  await panel.load('', false, 0);
  assert.equal(panel.state().loading, false);
  assert.equal(panel.state().loaded, false);
  assert.equal(panel.state().hasHistorical, false);
  requests[0].resolve(snapshot(1));
  await pending;
  assert.equal(panel.state().history.length, 0);
  assert.equal(panel.state().loaded, false);
});

test('an older response cannot overwrite the selected address history', async () => {
  const { panel, requests } = createHistory();
  const old = panel.load('thor1first', false, 0);
  const current = panel.load('thor1second', false, 0);
  requests[1].resolve(snapshot(2));
  await current;
  requests[0].resolve(snapshot(1));
  await old;
  assert.equal(panel.state().history[0].height, 2);
});

test('copy link preserves the displayed address scope, bond tab and chosen currency', async () => {
  let copied;
  const { panel } = createHistory({ writeText: async (value) => { copied = value; }, currency: 'BTC' });
  panel.addresses(['thor1selected']);
  await panel.copyLink();
  const url = new URL(copied);
  assert.equal(url.pathname, '/thorfolio');
  assert.equal(url.searchParams.get('addresses'), 'thor1selected');
  assert.equal(url.searchParams.get('currency'), 'BTC');
  assert.equal(url.searchParams.get('tab'), 'bond');
  assert.equal(url.hash, '');
  assert.equal(panel.state().copyState, 'copied');
});

test('unavailable clipboard leaves a manually copyable link and explicit failure state', async () => {
  const { panel } = createHistory();
  panel.addresses(['thor1selected']);
  await panel.copyLink();
  assert.equal(panel.state().copyState, 'failed');
  assert.match(panel.state().shareUrl, /addresses=thor1selected/);
});
