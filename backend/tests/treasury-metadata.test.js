import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEvmChainHoldings } from '../src/treasury/providers.js';
import { acquisitionDatabase } from './fixtures/acquisition-db.js';

test('EVM balances stay live while token decimals are reused across wallets and revalidated after expiry', async () => {
  const client = acquisitionDatabase();
  const batches = [];
  const options = { cooldownClient: client, nowMs: Date.parse('2026-09-02T12:00:00Z'),
    rpcEndpoints: { BSC: ['https://rpc.invalid'] }, fetchImpl: async (_url, request) => {
      const batch = JSON.parse(request.body);
      batches.push(batch);
      return new Response(JSON.stringify(batch.map((call) => ({ id: call.id, result:
        call.method === 'eth_getBalance' ? '0x0' : call.params[0].data === '0x313ce567' ? '0x6' : '0xf4240'
      }))));
    } };
  const assets = ['BSC.USDC-0x1234'];
  assert.equal((await fetchEvmChainHoldings('0xaaaa', 'BSC', assets, options))[0].amount, 1);
  assert.equal((await fetchEvmChainHoldings('0xbbbb', 'BSC', assets, options))[0].amount, 1);
  assert.equal(batches[0].length, 3);
  assert.equal(batches[1].length, 2);
  await fetchEvmChainHoldings('0xaaaa', 'BSC', assets, { ...options, nowMs: options.nowMs + 86_400_001 });
  assert.equal(batches[2].length, 3);
});
