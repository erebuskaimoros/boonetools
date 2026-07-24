import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTED_LEG_VOLUME_BASIS,
  buildAffiliateTransactionRows,
  buildAffiliateLegVolumeSeries,
  getAffiliateActionLegCount,
  getAffiliateActionLegVolumeUsd,
  getAffiliateActionRouteVolumeUsd
} from '../../shared/dynamic-fees/affiliate-volume.js';
import {
  fetchDynamicFeeAffiliateActions,
  getDynamicFeeAffiliateVolume
} from '../src/shared/dynamic-fee-affiliate-volume.js';

const DAY_SECONDS = 24 * 60 * 60;
const DAY_START = Date.parse('2026-06-28T00:00:00Z') / 1000;

function swapAction({
  txId = 'TX-1',
  timestamp = DAY_START + 60,
  height = 100,
  lastHeight = height,
  amount = '10000000000',
  priceUsd = '2',
  sourceAsset = 'BTC.BTC',
  targetAsset = 'ETH.ETH',
  pools = ['BTC.BTC', 'ETH.ETH'],
  liquidityFee = '250000000'
} = {}) {
  return {
    date: String(BigInt(timestamp) * 1_000_000_000n),
    height: String(height),
    in: [{ txID: txId, coins: [{ amount, asset: sourceAsset }] }],
    out: [{ coins: [{ amount: '1', asset: targetAsset }] }],
    pools,
    status: 'success',
    metadata: {
      swap: {
        inPriceUSD: priceUsd,
        isStreamingSwap: lastHeight > height,
        liquidityFee,
        swapSlip: '20',
        streamingSwapMeta: { lastHeight: String(lastHeight) }
      }
    }
  };
}

test('affiliate volume distinguishes route notional from canonical executed-leg volume', () => {
  const doubleSwap = swapAction();
  const singleSwap = swapAction({
    timestamp: DAY_START + 120,
    amount: '5000000000',
    priceUsd: '3',
    sourceAsset: 'THOR.RUNE',
    targetAsset: 'BTC.BTC',
    pools: ['BTC.BTC']
  });

  assert.equal(getAffiliateActionRouteVolumeUsd(doubleSwap), 200);
  assert.equal(getAffiliateActionLegCount(doubleSwap), 2);
  assert.equal(getAffiliateActionLegVolumeUsd(doubleSwap), 400);
  assert.equal(getAffiliateActionRouteVolumeUsd(singleSwap), 150);
  assert.equal(getAffiliateActionLegCount(singleSwap), 1);
  assert.equal(getAffiliateActionLegVolumeUsd(singleSwap), 150);

  const points = buildAffiliateLegVolumeSeries([doubleSwap, singleSwap], {
    fromTimestamp: DAY_START,
    toTimestamp: DAY_START + 2 * DAY_SECONDS
  });

  assert.equal(points.length, 2);
  assert.deepEqual(points[0], {
    startTime: String(DAY_START),
    endTime: String(DAY_START + DAY_SECONDS),
    legVolumeUsd: 550,
    routeVolumeUsd: 350,
    routeCount: 2,
    executedLegCount: 3,
    volumeBasis: EXECUTED_LEG_VOLUME_BASIS
  });
  assert.equal(points[1].legVolumeUsd, 0);
  assert.equal(points[1].routeVolumeUsd, 0);
});

test('affiliate volume pagination follows opaque Midgard page tokens', async () => {
  const calls = [];
  const actions = await fetchDynamicFeeAffiliateActions({
    affiliate: 'SS',
    fromTimestamp: DAY_START,
    toTimestamp: DAY_START + DAY_SECONDS,
    fetchActions: async (params) => {
      calls.push(params);
      return params.prevPageToken
        ? {
            actions: [swapAction({ timestamp: DAY_START + 120 })],
            meta: {}
          }
        : {
            actions: [swapAction({ timestamp: DAY_START + 60 })],
            meta: { prevPageToken: 'opaque-page' }
          };
    }
  });

  assert.equal(actions.length, 2);
  assert.equal(calls[0].affiliate, 'ss');
  assert.equal(calls[0].type, 'swap');
  assert.equal(calls[0].timestamp, String(DAY_START + DAY_SECONDS));
  assert.equal(calls[1].prevPageToken, 'opaque-page');
  assert.equal(calls[1].timestamp, undefined);
  assert.equal(calls[1].fromTimestamp, undefined);
});

test('affiliate transaction rows expose chart-compatible volume and sort largest first', () => {
  const rows = buildAffiliateTransactionRows([
    swapAction({
      txId: 'SMALL',
      timestamp: DAY_START + 120,
      amount: '1000000000',
      priceUsd: '2',
      pools: ['BTC.BTC']
    }),
    swapAction({
      txId: 'LARGE',
      timestamp: DAY_START + 60,
      lastHeight: 105
    }),
    swapAction({
      txId: 'OUTSIDE',
      timestamp: DAY_START + DAY_SECONDS
    })
  ], {
    fromTimestamp: DAY_START,
    toTimestamp: DAY_START + DAY_SECONDS
  });

  assert.deepEqual(rows.map((row) => row.txId), ['LARGE', 'SMALL']);
  assert.equal(rows[0].routeVolumeUsd, 200);
  assert.equal(rows[0].volumeUsd, 400);
  assert.equal(rows[0].executedLegCount, 2);
  assert.equal(rows[0].liquidityFeeRune, 2.5);
  assert.equal(rows[0].streaming, true);
  assert.equal(rows[0].endHeight, 105);
  assert.equal(rows[0].volumeBasis, EXECUTED_LEG_VOLUME_BASIS);
});

test('affiliate volume response exposes leg and route totals separately', async () => {
  const result = await getDynamicFeeAffiliateVolume({
    affiliate: 'ss',
    fromTimestamp: DAY_START,
    toTimestamp: DAY_START + DAY_SECONDS,
    fetchActions: async () => ({
      actions: [swapAction()],
      meta: {}
    })
  });

  assert.equal(result.volumeBasis, EXECUTED_LEG_VOLUME_BASIS);
  assert.equal(result.legVolumeUsd, 400);
  assert.equal(result.routeVolumeUsd, 200);
  assert.equal(result.routeCount, 1);
  assert.equal(result.executedLegCount, 2);
  assert.equal(result.transactions, undefined);
});

test('affiliate volume includes transaction details only when requested', async () => {
  const result = await getDynamicFeeAffiliateVolume({
    affiliate: 'ss',
    fromTimestamp: DAY_START,
    toTimestamp: DAY_START + DAY_SECONDS,
    includeTransactions: true,
    fetchActions: async () => ({
      actions: [swapAction()],
      meta: {}
    })
  });

  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].txId, 'TX-1');
  assert.equal(result.transactions[0].volumeUsd, result.legVolumeUsd);
});
