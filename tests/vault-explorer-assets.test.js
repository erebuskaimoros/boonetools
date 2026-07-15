import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustodiedAssetRows,
  summarizeCustodiedAssetRows
} from '../src/lib/vault-explorer/assets.js';

test('builds exogenous custody rows from pooled, trade, and secured balances', () => {
  const assets = buildCustodiedAssetRows([
    {
      poolAsset: 'THOR.RUNE',
      displayName: 'RUNE',
      totalValueUSD: 999,
      assetTypes: [{ type: 'native', totalAmount: 100, totalValueUSD: 999 }]
    },
    {
      poolAsset: 'BTC.BTC',
      displayName: 'BTC',
      status: 'Available',
      assetTypes: [
        { type: 'native', totalAmount: 10, totalValueUSD: 1_000_000 },
        { type: 'trade', totalAmount: 2, totalValueUSD: 200_000 },
        { type: 'secured', totalAmount: 3, totalValueUSD: 300_000 }
      ]
    },
    {
      poolAsset: 'ETH.ETH',
      displayName: 'ETH',
      status: 'Available',
      assetTypes: [{ type: 'native', totalAmount: 100, totalValueUSD: 500_000 }]
    }
  ]);

  assert.equal(assets.length, 2);
  assert.equal(assets[0].poolAsset, 'BTC.BTC');
  assert.equal(assets[0].chain, 'BTC');
  assert.deepEqual(assets[0].pooled, { amount: 10, valueUSD: 1_000_000 });
  assert.deepEqual(assets[0].trade, { amount: 2, valueUSD: 200_000 });
  assert.deepEqual(assets[0].secured, { amount: 3, valueUSD: 300_000 });
  assert.equal(assets[0].totalAmount, 15);
  assert.equal(assets[0].totalValueUSD, 1_500_000);
  assert.deepEqual(assets[1].trade, { amount: 0, valueUSD: 0 });
});

test('summarizes only exogenous custody values and reconciles category totals', () => {
  const assets = buildCustodiedAssetRows([
    {
      poolAsset: 'BTC.BTC',
      displayName: 'BTC',
      assetTypes: [
        { type: 'native', totalAmount: 1, totalValueUSD: 100 },
        { type: 'trade', totalAmount: 2, totalValueUSD: 200 }
      ]
    },
    {
      poolAsset: 'ETH.ETH',
      displayName: 'ETH',
      assetTypes: [{ type: 'secured', totalAmount: 3, totalValueUSD: 300 }]
    }
  ]);

  const summary = summarizeCustodiedAssetRows(assets);

  assert.deepEqual(summary, {
    assetCount: 2,
    totalValueUSD: 600,
    pooledTotalUSD: 100,
    tradeTotalUSD: 200,
    securedTotalUSD: 300
  });
  assert.equal(
    summary.totalValueUSD,
    summary.pooledTotalUSD + summary.tradeTotalUSD + summary.securedTotalUSD
  );
});
