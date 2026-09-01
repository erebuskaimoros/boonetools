import assert from 'node:assert/strict';
import test from 'node:test';

import { groupStuckTransactionsByChain } from '../src/lib/status/stuck-transactions.js';

test('stuck transactions are bundled by chain with worst cases first', () => {
  const transactions = [
    { tx_id: 'BTC-OLD', chain: 'btc', stage_label: 'Outbound pending', overdue_blocks: 120 },
    { tx_id: 'ETH-ONE', chain: 'ETH', stage_label: 'Swap pending', overdue_blocks: 80 },
    { tx_id: 'BTC-NEW', chain: 'BTC', stage_label: 'Streaming stalled', overdue_blocks: 40 },
    { tx_id: 'UNKNOWN', chain: '', stage_label: '', overdue_blocks: 10 }
  ];

  const groups = groupStuckTransactionsByChain(transactions);

  assert.deepEqual(groups.map((group) => ({
    chain: group.chain,
    count: group.count,
    maxOverdueBlocks: group.maxOverdueBlocks,
    stageLabels: group.stageLabels,
    txIds: group.transactions.map((transaction) => transaction.tx_id)
  })), [
    {
      chain: 'BTC',
      count: 2,
      maxOverdueBlocks: 120,
      stageLabels: ['Outbound pending', 'Streaming stalled'],
      txIds: ['BTC-OLD', 'BTC-NEW']
    },
    {
      chain: 'ETH',
      count: 1,
      maxOverdueBlocks: 80,
      stageLabels: ['Swap pending'],
      txIds: ['ETH-ONE']
    },
    {
      chain: 'UNKNOWN',
      count: 1,
      maxOverdueBlocks: 10,
      stageLabels: ['Unknown stage'],
      txIds: ['UNKNOWN']
    }
  ]);

  assert.equal(transactions[0].chain, 'btc');
});

test('invalid stuck transaction input produces no chain bundles', () => {
  assert.deepEqual(groupStuckTransactionsByChain(null), []);
  assert.deepEqual(groupStuckTransactionsByChain({}), []);
});

test('multiple stuck stages for one transaction expose unique render keys', () => {
  const [group] = groupStuckTransactionsByChain([
    {
      tx_id: 'DUPLICATE-TX',
      chain: 'ETH',
      stage: 'outbound_signing',
      stage_label: 'Outbound signing',
      overdue_blocks: 120
    },
    {
      tx_id: 'DUPLICATE-TX',
      chain: 'ETH',
      stage: 'scheduled_outbound',
      stage_label: 'Scheduled outbound',
      overdue_blocks: 120
    }
  ]);

  const renderKeys = group.transactions.map((transaction) => transaction.renderKey);
  assert.equal(new Set(renderKeys).size, group.transactions.length);
  assert.deepEqual(renderKeys, [
    'DUPLICATE-TX:outbound_signing',
    'DUPLICATE-TX:scheduled_outbound'
  ]);
});
