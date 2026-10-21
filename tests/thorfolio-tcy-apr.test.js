import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { buildTcyRows, weightedTcyPayoutApr } from '../src/lib/position-tracker/model.js';

const A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const DAY = 86400;
const NOW = Date.UTC(2026, 9, 21, 6) / 1000;
const payout = (daysAgo, rune) => ({ date: String(NOW - daysAgo * DAY), amount: String(Math.round(rune * 1e8)), price: '67000000' });

function buildRow(overrides = {}) {
  return buildTcyRows({
    addresses: [A],
    stakers: { [A]: { amount: String(1000e8) } },
    distributions: { [A]: { distributions: [payout(1, 2)] } },
    tcyPriceUsd: 0.16,
    runePriceUsd: 0.67,
    nowSec: NOW,
    ...overrides
  })[0];
}

test('equal TCY payout rates do not inherit Midgard APR inflated by unsorted history', () => {
  // Reproduces the live failure: the first returned event is 3.7 days old,
  // but the account has over a year of payouts. Midgard annualizes its full
  // 30-day rewards over that arbitrary first-row age and returns ~70%.
  const payoutsA = [payout(400, 1), payout(3.7, 0.3), payout(15, 0.7), payout(1, 1)];
  const payoutsB = [payout(3.7, 0.03), payout(400, 0.1), payout(1, 0.1), payout(15, 0.07)];
  const rows = buildTcyRows({
    addresses: [A, B],
    stakers: { [A]: { amount: '100000000000' }, [B]: { amount: '10000000000' } },
    distributions: {
      [A]: { apr: '0.08626523709104233', distributions: payoutsA },
      [B]: { apr: '0.7010729154257432', distributions: payoutsB }
    },
    tcyPriceUsd: 0.16,
    runePriceUsd: 0.67,
    nowSec: NOW
  });
  assert.ok(Math.abs(rows[0].apr - rows[1].apr) < 1e-8, 'same rewards per staked TCY must produce the same APR regardless of upstream APR or payout order');
  const expected = 2 * 0.67 / (1000 * 0.16) * (365 / 30) * 100;
  assert.ok(Math.abs(rows[0].apr - expected) < 1e-8, 'annualize only the last 30 days at current RUNE/TCY prices');
});

test('30-day APR includes exact boundaries and excludes older and future payouts without changing history', () => {
  const entries = [payout(30, 2), payout(0, 3), payout(30 + 1 / DAY, 100), payout(-1 / DAY, 200)];
  const row = buildRow({ distributions: { [A]: { apr: '900', distributions: entries } } });
  const expected = 5 * 0.67 / (1000 * 0.16) * (365 / 30) * 100;
  assert.ok(Math.abs(row.apr - expected) < 1e-8);
  assert.equal(row.payouts.length, 4);
  assert.equal(row.totalPayoutRune, 305);
  assert.equal(row.lastPayout.date, NOW + 1);
  const reversed = buildRow({ distributions: { [A]: { distributions: [...entries].reverse() } } });
  assert.equal(reversed.apr, row.apr);
  assert.deepEqual(reversed.payouts, row.payouts);
});

test('recent stakes retain the fixed 30-day denominator and use current prices, not payout prices', () => {
  const row = buildRow({ distributions: { [A]: { distributions: [{ ...payout(0.5, 2), price: String(10e8) }] } } });
  assert.ok(Math.abs(row.apr - 2 * 0.67 / (1000 * 0.16) * (365 / 30) * 100) < 1e-8);
  assert.equal(row.totalPayoutUsdAtPayout, 20, 'historical payout valuation remains unchanged');
});

test('missing or malformed payout data is unavailable, distinct from a known empty history', () => {
  for (const payload of [undefined, null, {}, { apr: '0.9' }, { distributions: null }, { distributions: {} },
    { distributions: [null] }, { distributions: [{ amount: '10' }] },
    { distributions: [{ ...payout(1, 2), date: 'invalid' }] },
    { distributions: [{ ...payout(1, 2), amount: '-1' }] },
    { distributions: [{ ...payout(1, 2), amount: '' }] },
    { distributions: [{ ...payout(1, 2), amount: 'Infinity' }] },
    { distributions: [payout(1, 2), { date: 'unknown', amount: '100' }] }
  ]) {
    const row = buildRow({ distributions: { [A]: payload } });
    assert.equal(row.apr, null, JSON.stringify(payload));
  }
  assert.equal(buildRow({ distributions: { [A]: { distributions: [] } } }).apr, 0);
  assert.equal(buildRow({ distributions: { [A]: { distributions: [payout(31, 10)] } } }).apr, 0);
});

test('APR is unavailable without positive current stake, valid prices, or an observation time', () => {
  for (const overrides of [
    { stakers: {} }, { stakers: { [A]: { amount: '0' } } }, { stakers: { [A]: { amount: 'invalid' } } },
    ...[0, -1, null, NaN, Infinity, 'invalid'].flatMap((price) => [{ tcyPriceUsd: price }, { runePriceUsd: price }]),
    ...[null, NaN, Infinity, 0].map((nowSec) => ({ nowSec }))
  ]) assert.equal(buildRow(overrides).apr, null);
});

test('combined APR is stake weighted and unavailable if any staked row is missing its APR', () => {
  assert.equal(weightedTcyPayoutApr([{ staked: 1000, apr: 10 }, { staked: 100, apr: 20 }]), 12000 / 1100);
  assert.equal(weightedTcyPayoutApr([{ staked: 1000, apr: 10 }, { staked: 100, apr: null }]), null);
  assert.equal(weightedTcyPayoutApr([{ staked: 1000, apr: 10 }, { staked: 0, apr: null }]), 10);
  assert.equal(weightedTcyPayoutApr([{ staked: 1000, apr: 0 }]), 0);
  assert.equal(weightedTcyPayoutApr([{ staked: 0, apr: null }]), null);
  assert.equal(weightedTcyPayoutApr([]), null);
});

async function compiledComponentUrl(url) {
  const { js } = compile(await readFile(url, 'utf8'), { generate: 'server', filename: url.pathname });
  let code = js.code;
  for (const [statement, quote, specifier] of js.code.matchAll(/from (['"])([^'"]+)\1/g)) {
    const resolved = specifier.endsWith('.svelte')
      ? await compiledComponentUrl(new URL(specifier, url))
      : specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
    code = code.replace(statement, `from ${quote}${resolved}${quote}`);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}

async function renderPanel(rows) {
  const url = new URL('../src/lib/position-tracker/TcyPanel.svelte', import.meta.url);
  const { default: Component } = await import(await compiledComponentUrl(url));
  return render(Component, { props: { rows, hasThor: true, loadedOnce: true } }).body;
}

test('TCY panel labels the basis and renders missing APR as unavailable while preserving measured zero', async () => {
  const unavailable = await renderPanel([buildRow({ distributions: {} })]);
  assert.equal((unavailable.match(/30d payout APR/g) || []).length, 2);
  assert.match(unavailable, /stake changes affect this ratio/);
  assert.match(unavailable, /window stays 30 days even for new stakes/);
  assert.match(unavailable, /current stake &amp; prices/);
  assert.match(unavailable, /class="metric-value"[^>]*>—<\/strong>/);
  assert.match(unavailable, /<td class="right" title="Unavailable:[^"]*">—<\/td>/);
  assert.doesNotMatch(unavailable, /0\.00%/);
  const measuredZero = await renderPanel([buildRow({ distributions: { [A]: { distributions: [] } } })]);
  assert.equal((measuredZero.match(/0\.00%/g) || []).length, 2);
});

test('TCY panel renders failed stake and wallet balances as unavailable while retaining payout history', async () => {
  const unavailable = await renderPanel([buildRow({ stakers: { [A]: null }, balances: { [A]: null } })]);
  const stakeCard = unavailable.split('>staked</span>')[1]?.split('</div>')[0];
  assert.ok(stakeCard, 'staked card must be present');
  assert.match(stakeCard, /class="metric-value"[^>]*>—<\/strong>/);
  assert.match(unavailable, /stake unavailable/i);
  assert.match(unavailable, /wallet balance unavailable/i);
  assert.match(unavailable, /2 ᚱ/, 'known payouts remain visible');
  assert.doesNotMatch(unavailable, />0 unstaked in wallet/);
});
