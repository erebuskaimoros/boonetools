import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getEthTokenContractAddress,
  isEthTokenAsset,
  toThorchainBaseAmount
} from '../src/lib/vault-explorer/eth-balances.js';

test('identifies ETH contract assets', () => {
  assert.equal(isEthTokenAsset('ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'), true);
  assert.equal(isEthTokenAsset('ETH.USDC-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), true);
  assert.equal(isEthTokenAsset('ETH.ETH'), false);
  assert.equal(isEthTokenAsset('AVAX.USDC-0XB97EF9EF8734C71904D8002F8B6BC66DD9C48A6E'), false);
});

test('extracts ETH token contract addresses', () => {
  assert.equal(
    getEthTokenContractAddress('ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'),
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  );
  assert.equal(getEthTokenContractAddress('ETH.ETH'), null);
});

test('converts raw on-chain balances to THORChain 1e8 base units', () => {
  assert.equal(toThorchainBaseAmount(1_261_986_531_199n, 6), '126198653119900');
  assert.equal(toThorchainBaseAmount(5_20629375n, 8), '520629375');
  assert.equal(toThorchainBaseAmount(819298260000000000n, 18), '81929826');
});
