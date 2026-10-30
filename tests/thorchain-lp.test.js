import test from 'node:test';
import assert from 'node:assert/strict';
import { lpRedeemValues, safeShare } from '../shared/thorchain-lp.js';

test('safe share caps ownership and rounds half up like THORNode', () => {
  assert.equal(safeShare('1', '3', '10'), 3n);
  assert.equal(safeShare('1', '4', '10'), 3n);
  assert.equal(safeShare('5', '4', '10'), 10n);
  assert.equal(safeShare('0', '4', '10'), 0n);
  assert.equal(safeShare('1', 'bad', '10'), 0n);
});

test('LP redeem values use pool units, which include synth units', () => {
  assert.deepEqual(
    lpRedeemValues('25', { pool_units: '100', balance_rune: '9007199254740993', balance_asset: '400' }),
    { rune_redeem_value: '2251799813685248', asset_redeem_value: '100' }
  );
});
