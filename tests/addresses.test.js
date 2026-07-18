import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KNOWN_ADDRESSES,
  PROTOCOL_ADDRESSES,
  THORCHAIN_MODULES,
  getAddressLabel
} from '../src/lib/constants/addresses.js';

const RESERVE_ADDRESS = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt';
const RUNE_POOL_ADDRESS = 'thor1rzqfv62dzu585607s5awqtgnvvwz5rzhdtv772';

test('Reserve and RUNEPool use their distinct canonical module addresses', () => {
  assert.equal(THORCHAIN_MODULES[RESERVE_ADDRESS], 'Reserve');
  assert.equal(PROTOCOL_ADDRESSES[RUNE_POOL_ADDRESS], 'RUNEPool');
  assert.equal(PROTOCOL_ADDRESSES[RESERVE_ADDRESS], undefined);
  assert.equal(KNOWN_ADDRESSES[RESERVE_ADDRESS], 'Reserve');
  assert.equal(KNOWN_ADDRESSES[RUNE_POOL_ADDRESS], 'RUNEPool');
  assert.equal(getAddressLabel(RESERVE_ADDRESS), 'Reserve');
  assert.equal(getAddressLabel(RUNE_POOL_ADDRESS), 'RUNEPool');
});
