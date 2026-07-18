import test from 'node:test';
import assert from 'node:assert/strict';

import {
  affiliateDisplayName,
  computeDistributions,
  computeSwapPathData,
  distributionsFromPreaggregates,
  formatTimeSaved,
  shortenAsset,
  sortSwaps,
  swapPathDataFromPreaggregates,
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

test('compact rapid-swap preaggregates preserve all-time distribution and path views', () => {
  const preaggregates = {
    distributions: {
      sub_swaps: [
        { bucket: '4-5', sort_order: 2, swap_count: 3, volume_usd: 150 },
        { bucket: '2-3', sort_order: 1, swap_count: 2, volume_usd: 100 }
      ],
      time_saved_seconds: [
        { bucket: '<1m', sort_order: 2, swap_count: 4, volume_usd: 200 }
      ]
    },
    affiliates: [
      { affiliate: 't', swap_count: 5, volume_usd: 250 }
    ],
    paths: [
      {
        source_asset: 'BTC.BTC',
        target_asset: 'ETH.ETH',
        volume_usd: 250,
        avg_time_saved_seconds: 42
      }
    ],
    sankey: [
      { source_asset: 'BTC.BTC', target_asset: 'ETH.ETH', volume_usd: 250 }
    ]
  };

  const distributions = distributionsFromPreaggregates(preaggregates);
  assert.deepEqual(distributions.subLabels, ['2-3', '4-5']);
  assert.deepEqual(distributions.subsByCount, [2, 3]);
  assert.deepEqual(distributions.affCountLabels, ['THORSwap']);

  const paths = swapPathDataFromPreaggregates(preaggregates);
  assert.deepEqual(paths.volumeLabels, ['BTC.BTC → ETH.ETH']);
  assert.deepEqual(paths.timeSavedValues, [42]);
  assert.deepEqual(paths.sankeyFlows, [{ from: 'BTC', to: 'ETH', flow: 250 }]);
});
