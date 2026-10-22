import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import axios from 'axios';
import protobuf from 'protobufjs';
import { AssetValue, Chain, USwap } from '@tcswap/core';

test('legacy wallet Base58 consumers retain the patched v4 decoder', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location.endsWith('/bs58') && entry.version.startsWith('4.')) {
      assert.notEqual(entry.version, '4.0.0', `${location} retains the unpatched decoder dependency`);
    }
  }
  const requireForNear = createRequire(import.meta.resolve('@near-js/keystores-browser'));
  const base58 = requireForNear('bs58');
  const bytes = Buffer.from([0, 0, 1, 2, 3, 254, 255]);
  const encoded = base58.encode(bytes);
  assert.ok(encoded.startsWith('11'), 'leading zero bytes must be preserved');
  assert.deepEqual(base58.decode(encoded), bytes);
  assert.throws(() => base58.decode(`${encoded}\u0100`), /Non-base58 character/);
});

test('patched wallet SDK preserves exact RUNE base-unit amounts without signing', () => {
  assert.equal(Chain.THORChain, 'THOR');
  assert.equal(typeof USwap, 'function');
  for (const [value, baseUnits] of [
    ['0', '0'],
    ['0.00000001', '1'],
    ['1.23456789', '123456789'],
    ['90071992.54740993', '9007199254740993']
  ]) {
    const asset = AssetValue.from({ asset: 'THOR.RUNE', value });
    assert.equal(asset.toString(), 'THOR.RUNE');
    assert.equal(asset.getBaseValue('string'), baseUnits);
  }
});

test('patched protobuf keeps byte fields and large integer amounts lossless', () => {
  const root = protobuf.parse(`syntax = "proto3";
    message Transfer {
      bytes signer = 1;
      uint64 amount = 2;
      string memo = 3;
    }`).root;
  const Transfer = root.lookupType('Transfer');
  const source = { signer: 'AQID', amount: '9007199254740993', memo: 'BOND:fixture' };
  const encoded = Transfer.encode(Transfer.fromObject(source)).finish();
  const decoded = Transfer.toObject(Transfer.decode(encoded), { longs: String, bytes: String });
  assert.deepEqual(decoded, source);
});

test('patched Axios preserves JSON responses and requested URL parameters', async () => {
  let request;
  const response = await axios.get('/fixture/pool', {
    params: { asset: 'THOR.RUNE', interval: 'day' },
    adapter: async (config) => {
      request = config;
      return { data: '{"amount":"9007199254740993"}', status: 200,
        statusText: 'OK', headers: { 'content-type': 'application/json' }, config };
    }
  });
  assert.equal(request.method, 'get');
  assert.equal(axios.getUri(request), '/fixture/pool?asset=THOR.RUNE&interval=day');
  assert.deepEqual(response.data, { amount: '9007199254740993' });
});
