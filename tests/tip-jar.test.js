import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TIP_JAR_ADDRESS, TIP_PRESETS_USD, runeForUsd, tipAmountProblem } from '../src/lib/tip-jar/tip-jar.js';
import { planSendRune } from '../src/lib/position-tracker/memos.js';

const source = (file) => readFile(new URL(file, import.meta.url), 'utf8');

test('the modal prefills $3 of RUNE, rounded up so the tip is never short', () => {
  assert.equal(TIP_PRESETS_USD[0], 3);
  assert.equal(runeForUsd(3, 0.674), '4.46');
  assert.equal(runeForUsd(10, 2), '5.00');
  assert.equal(runeForUsd(3, 0), '');
});

test('amounts must be positive, at most 8 decimals, and covered with the network fee', () => {
  assert.notEqual(tipAmountProblem(''), '');
  assert.notEqual(tipAmountProblem('abc'), '');
  assert.notEqual(tipAmountProblem('0'), '');
  assert.notEqual(tipAmountProblem('1.123456789'), '');
  assert.equal(tipAmountProblem('4.46'), '');
  assert.equal(tipAmountProblem('4.9', { balanceRune: 5, feeRune: 0.02 }), '');
  assert.match(tipAmountProblem('5', { balanceRune: 5, feeRune: 0.02 }), /network fee/);
});

test('a tip is a plain MsgSend of RUNE to a thor1 address, with no memo', async () => {
  const plan = planSendRune({ amount: '4.46', recipient: TIP_JAR_ADDRESS });
  assert.deepEqual(
    { route: plan.route, chain: plan.chain, asset: plan.asset, amount: plan.amount, recipient: plan.recipient, memo: plan.memo },
    { route: 'thor-send', chain: 'THOR', asset: 'THOR.RUNE', amount: '4.46', recipient: TIP_JAR_ADDRESS, memo: '' }
  );
  assert.throws(() => planSendRune({ amount: '1', recipient: 'bc1qz375gdj6hdd7wr54nfnr2lvssfesna23njrx7a' }), /thor1/);
  assert.throws(() => planSendRune({ amount: '-1', recipient: TIP_JAR_ADDRESS }), /positive/);
  assert.match(await source('../src/lib/position-tracker/actions.js'), /case 'thor-send':[\s\S]*?uSwap\.transfer\(\{ assetValue, recipient: plan\.recipient/);
});

test('the footer offers a coffee and loads the send modal only when asked', async () => {
  const footer = await source('../src/lib/Footer.svelte');
  assert.match(footer, /<span class="tip-label">buy me a coffee\?<\/span>/);
  assert.match(footer, /aria-expanded=\{tipOpen\}[\s\S]*aria-controls="tip-panel"[\s\S]*on:click=\{toggleTipJar\}/);
  // Docked like the swap panel and never both at once.
  assert.match(footer, /\$: if \(\$swapOpen\) tipOpen = false;/);
  assert.match(footer, /await import\('\.\/tip-jar\/TipJarModal\.svelte'\)/);
  assert.doesNotMatch(footer, /clipboard/);
  const panel = await source('../src/lib/tip-jar/TipJarModal.svelte');
  assert.match(panel, /navigator\.clipboard\.writeText\(TIP_JAR_ADDRESS\)/);
  assert.match(panel, /id="tip-panel"[^>]*aria-modal="false"/);
});

test('bond yield payout stays disabled until the network gate opens', async () => {
  const panel = await source('../src/lib/position-tracker/BondPanel.svelte');
  assert.match(panel, /disabled=\{!gates\.bondYieldEnabled \|\| !BOND_YIELD_STATUSES\.has\(row\.status\)\}[^\n]*>payout<\/button>/);
});
