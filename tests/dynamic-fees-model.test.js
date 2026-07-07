import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAffiliateChartSeries,
  buildAffiliateMidgardSeries,
  buildAffiliateRollups,
  buildEpochChartSeries,
  buildDynamicFeeModel,
  computeEpochTiming,
  extractDynamicConfig,
  formatPairDisplayName,
  inferDynamicFeeDecision,
  liveSealEpoch
} from '../src/lib/dynamic-fees/model.js';

test('formatPairDisplayName removes token contract addresses from display labels', () => {
  assert.equal(
    formatPairDisplayName('ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48|BTC.BTC'),
    'ETH.USDC / BTC.BTC'
  );
  assert.equal(
    formatPairDisplayName('TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T|THOR.RUNE'),
    'TRON.USDT / THOR.RUNE'
  );
});

test('computeEpochTiming derives countdown and progress from live block height', () => {
  assert.deepEqual(
    computeEpochTiming({ epochBlocks: 100, blockHeight: 250 }),
    {
      blockHeight: 250,
      currentEpoch: 2,
      blocksUntilSeal: 50,
      epochProgress: 0.5
    }
  );

  assert.deepEqual(
    computeEpochTiming({ epochBlocks: 100, blockHeight: 300 }),
    {
      blockHeight: 300,
      currentEpoch: 3,
      blocksUntilSeal: 0,
      epochProgress: 1
    }
  );
});

test('liveSealEpoch reports the epoch where current accumulators will seal', () => {
  assert.equal(liveSealEpoch(1868), 1869);
  assert.equal(liveSealEpoch('1868'), 1869);
  assert.equal(liveSealEpoch(0), 0);
});

test('buildEpochChartSeries keeps sealed and live rows separate when epoch labels collide', () => {
  const series = buildEpochChartSeries(
    {
      history: [
        { epoch: 1862, feesUsd: 1.25, bpsAtClose: 1 },
        { epoch: 1863, feesUsd: 2.5, bpsAtClose: 1 }
      ],
      currentFeesUsd: 40,
      currentVolumeUsd: 1000,
      dynamicBps: 2
    },
    1863
  );

  assert.deepEqual(series.labels, ['E1862 sealed', 'E1863 sealed', 'E1863 live']);
  assert.deepEqual(series.fees, [1.25, 2.5, 40]);
  assert.deepEqual(series.bps, [1, 1, 2]);
});

test('buildEpochChartSeries labels adjusted live seal epoch separately', () => {
  const series = buildEpochChartSeries(
    {
      history: [
        { epoch: 1862, feesUsd: 1.25, bpsAtClose: 1 },
        { epoch: 1863, feesUsd: 2.5, bpsAtClose: 1 }
      ],
      currentFeesUsd: 40,
      currentVolumeUsd: 1000,
      dynamicBps: 2
    },
    1864
  );

  assert.deepEqual(series.labels, ['E1862 sealed', 'E1863 sealed', 'E1864 live']);
  assert.deepEqual(series.fees, [1.25, 2.5, 40]);
});

test('buildAffiliateChartSeries keeps sealed and live affiliate metrics separate', () => {
  const series = buildAffiliateChartSeries(
    { currentEpoch: 1863 },
    [
      {
        currentVolumeUsd: 1000,
        currentFeesUsd: 4,
        history: [
          { epoch: 1862, volumeUsd: 500, feesUsd: 1 },
          { epoch: 1863, volumeUsd: 100, feesUsd: 0.5 }
        ]
      },
      {
        currentVolumeUsd: 0,
        currentFeesUsd: 0,
        history: [
          { epoch: 1862, volumeUsd: 1500, feesUsd: 3 }
        ]
      }
    ],
    [
      {
        epoch: 1863,
        volumeUsd: 2000,
        feesUsd: 2
      }
    ]
  );

  assert.deepEqual(series.labels, ['E1862 sealed', 'E1863 sealed', 'E1863 live']);
  assert.deepEqual(series.volume, [2000, 100, 3000]);
  assert.deepEqual(series.fees, [4, 0.5, 6]);
  assert.deepEqual(series.rateBps, [20, 50, 20]);
  assert.equal(series.hasLive, true);
});

test('buildAffiliateMidgardSeries merges historical affiliate volume and fees before ADR26', () => {
  const series = buildAffiliateMidgardSeries(
    [
      {
        startTime: '1782604800',
        endTime: '1782691200',
        totalVolumeUSD: '121800',
        count: '1',
        affiliates: [{ affiliate: 'symbiosis', volumeUSD: '121800', count: '1' }]
      },
      {
        startTime: '1782691200',
        endTime: '1782777600',
        totalVolumeUSD: '0',
        count: '0',
        affiliates: []
      }
    ],
    [
      {
        startTime: '1782604800',
        endTime: '1782691200',
        totalEarningsUSD: '250',
        count: '1',
        affiliates: [{ affiliate: 'symbiosis', earningsUSD: '250', count: '1' }]
      },
      {
        startTime: '1782691200',
        endTime: '1782777600',
        totalEarningsUSD: '0',
        count: '0',
        affiliates: []
      }
    ],
    'SYMBIOSIS'
  );

  assert.deepEqual(series.labels, ['06-28', '06-29']);
  assert.deepEqual(series.volume, [1218, 0]);
  assert.deepEqual(series.fees, [2.5, 0]);
  assert.equal(Number(series.rateBps[0].toFixed(2)), 20.53);
  assert.equal(series.rateBps[1], null);
  assert.equal(series.totalVolumeUsd, 1218);
  assert.equal(series.totalFeesUsd, 2.5);
  assert.equal(series.totalCount, 1);
});

test('buildAffiliateRollups includes whitelisted affiliates without merging sealed and live rows', () => {
  const affiliates = buildAffiliateRollups(
    {
      currentEpoch: 1863,
      whitelists: [
        { thorname: 'SYMBIOSIS', state: 1, label: 'active', kind: 'active' },
        { thorname: 'EMPTY', state: 2, label: 'monitor', kind: 'monitor' }
      ]
    },
    [
      {
        thorname: 'symbiosis',
        currentVolumeUsd: 1000,
        currentFeesUsd: 4,
        history: [
          { epoch: 1862, volumeUsd: 500, feesUsd: 1 },
          { epoch: 1863, volumeUsd: 100, feesUsd: 0.5 }
        ],
        isActive: true,
        isMonitor: false
      }
    ],
    [
      {
        id: 'symbiosis::ETH.ETH|BTC.BTC',
        thorname: 'symbiosis',
        pair: 'ETH.ETH|BTC.BTC',
        volumeUsd: 2000,
        feesUsd: 2
      }
    ]
  );

  assert.equal(affiliates.length, 2);
  assert.equal(affiliates[0].thorname, 'SYMBIOSIS');
  assert.equal(affiliates[0].liveVolumeUsd, 3000);
  assert.equal(affiliates[0].liveFeesUsd, 6);
  assert.equal(affiliates[0].historyVolumeUsd, 600);
  assert.equal(affiliates[0].historyFeesUsd, 1.5);
  assert.equal(affiliates[0].totalVolumeUsd, 3600);
  assert.equal(affiliates[0].totalFeesUsd, 7.5);
  assert.equal(affiliates[0].pairCount, 2);
  assert.equal(affiliates[0].livePairCount, 2);
  assert.deepEqual(affiliates[0].series.labels, ['E1862 sealed', 'E1863 sealed', 'E1863 live']);
  assert.equal(affiliates[1].thorname, 'EMPTY');
  assert.equal(affiliates[1].totalFeesUsd, 0);
});

test('extractDynamicConfig applies protocol defaults and whitelist counts', () => {
  const config = extractDynamicConfig({
    mimir: {
      ADR26: 1,
      'DYNAMICFEE-WHITELIST-ALICE': 1,
      'DYNAMICFEE-WHITELIST-BOB': 2
    },
    currentResponse: { epoch: '1861' },
    lastblock: [{ thorchain: 26_798_401 }]
  });

  assert.equal(config.adr26, 1);
  assert.equal(config.enabled, 0);
  assert.equal(config.epochBlocks, 14400);
  assert.equal(config.floorBps, 1);
  assert.equal(config.ceilingBps, 20);
  assert.equal(config.stepBps, 1);
  assert.equal(config.deadbandBps, 1000);
  assert.equal(config.windowEpochs, 3);
  assert.equal(config.reportedCurrentEpoch, 1861);
  assert.equal(config.currentEpoch, 1862);
  assert.equal(config.activeWhitelistCount, 1);
  assert.equal(config.monitorWhitelistCount, 1);
  assert.equal(config.whitelists[0].thorname, 'ALICE');
});

test('buildDynamicFeeModel reports approved empty state without records', () => {
  const model = buildDynamicFeeModel({
    mimir: { ADR26: 1 },
    recordsResponse: { entries: [] },
    currentResponse: { epoch: '1861', entries: [] },
    lastblock: [{ thorchain: 26_798_401 }]
  });

  assert.equal(model.summary.statusLabel, 'approved');
  assert.equal(model.summary.statusKind, 'warn');
  assert.equal(model.summary.recordCount, 0);
  assert.equal(model.summary.currentFeesUsd, 0);
});

test('buildDynamicFeeModel combines records, current accumulators, and history', () => {
  const model = buildDynamicFeeModel({
    mimir: {
      ADR26: 1,
      L1DynamicFeeEnabled: 1,
      L1DynamicFeeDeadbandBPS: 500,
      'DYNAMICFEE-WHITELIST-ALICE': 1
    },
    recordsResponse: {
      entries: [
        {
          thorname: 'alice',
          pair: 'BTC.BTC|THOR.RUNE',
          dynamic_bps: 5,
          whitelist_state: 1,
          last_active_epoch: 12,
          latest_fees_tor: '200000000'
        }
      ]
    },
    currentResponse: {
      epoch: '13',
      entries: [
        {
          thorname: 'alice',
          pair: 'BTC.BTC|THOR.RUNE',
          volume_tor: '10000000000',
          fees_tor: '100000000',
          epoch: 13
        }
      ]
    },
    detailsByThorname: {
      alice: {
        pairs: [
          {
            pair: 'BTC.BTC|THOR.RUNE',
            dynamic_bps: 5,
            last_active_epoch: 12,
            history: [
              { epoch: 10, fees_tor: '100000000', volume_tor: '10000000000', bps_at_close: 3 },
              { epoch: 11, fees_tor: '100000000', volume_tor: '10000000000', bps_at_close: 4 },
              { epoch: 12, fees_tor: '200000000', volume_tor: '10000000000', bps_at_close: 4 }
            ]
          }
        ]
      }
    },
    lastblock: [{ thorchain: 130 }]
  });

  assert.equal(model.summary.statusLabel, 'live');
  assert.equal(model.summary.recordCount, 1);
  assert.equal(model.summary.currentVolumeUsd, 100);
  assert.equal(model.summary.currentFeesUsd, 1);
  assert.equal(model.config.reportedCurrentEpoch, 13);
  assert.equal(model.config.currentEpoch, 14);
  assert.equal(model.currentEntries[0].reportedEpoch, 13);
  assert.equal(model.currentEntries[0].epoch, 14);
  assert.equal(model.records[0].activeEpoch, 14);
  assert.equal(model.records[0].staleEpochs, 0);
  assert.equal(model.records[0].currentRateBps, 100);
  assert.equal(model.records[0].decision.reason, 'continue_up');
  assert.equal(model.records[0].decision.movementLabel, 'up');
  assert.equal(model.records[0].decision.matchesExpected, true);
});

test('inferDynamicFeeDecision labels reverse down when prior raise hurt fees', () => {
  const decision = inferDynamicFeeDecision(
    [
      { epoch: 9, fees_tor: '200', bps_at_close: 5 },
      { epoch: 10, fees_tor: '200', bps_at_close: 8 },
      { epoch: 11, fees_tor: '50', bps_at_close: 8 }
    ],
    7,
    { floorBps: 1, ceilingBps: 20, stepBps: 1, deadbandBps: 500, windowEpochs: 3 }
  );

  assert.equal(decision.reason, 'reverse_down');
  assert.equal(decision.expectedNewBps, 7);
  assert.equal(decision.movementLabel, 'down');
});
