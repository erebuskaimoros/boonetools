import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateUtxoOnChainBalances } from '../src/lib/vault-explorer/utxo-balances.js';

test('hydrates LTC balances from the live address balance shape', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://litecoinspace.org/api/address/ltc1qvault');
    return {
      ok: true,
      json: async () => ({
        chain_stats: {
          funded_txo_sum: 61035757357,
          spent_txo_sum: 30000000000
        },
        mempool_stats: {
          funded_txo_sum: 0,
          spent_txo_sum: 0
        }
      })
    };
  };

  const [vault] = await hydrateUtxoOnChainBalances([
    {
      pub_key: 'thorpub1g6ac',
      addresses: [{ chain: 'LTC', address: 'ltc1qvault' }],
      coins: [{ asset: 'LTC.LTC', amount: '1035778282' }]
    }
  ]);

  assert.deepEqual(vault.coins.find((coin) => coin.asset === 'LTC.LTC'), {
    asset: 'LTC.LTC',
    amount: '31035757357',
    balance_source: 'ltc_chain',
    thornode_amount: '1035778282'
  });
});
