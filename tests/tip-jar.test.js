import assert from 'node:assert/strict';
import test from 'node:test';

import { TIP_JAR_ADDRESS, TIP_PRESETS_USD, runeForUsd, tipAmountProblem } from '../src/lib/tip-jar/tip-jar.js';
import { planSendRune } from '../src/lib/position-tracker/memos.js';

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
});
