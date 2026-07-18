import test from 'node:test';
import assert from 'node:assert/strict';

import {
  affiliateDisplayName,
  computeDistributions,
  computeSwapPathData,
  formatTimeSaved,
  shortenAsset,
  sortSwaps,
  swapPctFaster,
  swapTimeSaved
} from '../src/lib/rapid-swaps/presentation.js';

test('rapid-swap presentation helpers preserve terminal display values', () => {
  assert.equal(shortenAsset('ETH.USDC-0x1234567890abcdef'), 'ETH.USDC');
  assert.equal(shortenAsset('BTC.BTC'), 'BTC.BTC');
  assert.equal(formatTimeSaved(65), '1m 5s');
  assert.equal(formatTimeSaved(90_000), '1d 1h');
  assert.equal(affiliateDisplayName('t'), 'THORSwap');
  assert.equal(swapTimeSaved({ streaming_count: 10, blocks_used: 4 }), 36);
  assert.equal(swapPctFaster({ streaming_count: 10, blocks_used: 4 }), 60);
});

test('rapid-swap presentation builds distributions and path flows from one model', () => {
  const swaps = [
    {
      source_asset: 'BTC.BTC',
      target_asset: 'ETH.ETH',
      input_estimated_usd: 125,
      streaming_count: 8,
      blocks_used: 3,
      affiliate: 't'
    },
    {
      source_asset: 'BTC.BTC',
      target_asset: 'ETH.ETH',
      input_estimated_usd: 75,
      streaming_count: 12,
      blocks_used: 7,
      affiliate: 't'
    }
  ];

  const distributions = computeDistributions(swaps);
  assert.equal(distributions.subsByCount[0], 1);
  assert.equal(distributions.subsByCount[1], 1);
  assert.deepEqual(distributions.affCountLabels, ['THORSwap']);
  assert.deepEqual(distributions.affCountValues, [2]);
  assert.deepEqual(distributions.affVolumeValues, [200]);

  const paths = computeSwapPathData(swaps);
  assert.deepEqual(paths.volumeLabels, ['BTC.BTC → ETH.ETH']);
  assert.deepEqual(paths.volumeValues, [200]);
  assert.deepEqual(paths.sankeyFlows, [{ from: 'BTC', to: 'ETH', flow: 200 }]);
});

test('rapid-swap table sorting shares the same presentation calculations', () => {
  const rows = [
    { tx_id: 'slow', streaming_count: 4, blocks_used: 3, input_estimated_usd: 20 },
    { tx_id: 'fast', streaming_count: 10, blocks_used: 2, input_estimated_usd: 10 }
  ];
  assert.deepEqual(sortSwaps(rows, 'pctFaster', false).map((row) => row.tx_id), ['fast', 'slow']);
});
