import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustodiedAssetRows,
  buildPooledBalanceMap,
  getPooledRuneAmount,
  summarizeCustodiedAssetRows
} from '../src/lib/vault-explorer/assets.js';

test('uses pool depth for pooled balances and vault inventory only for distribution', () => {
  const pooled = buildPooledBalanceMap(
    [{ asset: 'BTC.BTC', balance_asset: '1000000000' }],
    { 'BTC.BTC': 50_000 },
    {
      'BTC.BTC': {
        0: { amount: 12, valueUSD: 600_000 },
        1: { amount: 8, valueUSD: 400_000 }
      }
    },
    2
  );

  assert.equal(pooled['BTC.BTC'][0].amount, 6);
  assert.equal(pooled['BTC.BTC'][1].amount, 4);
  assert.equal(pooled['BTC.BTC'][0].valueUSD, 300_000);
  assert.equal(pooled['BTC.BTC'][1].valueUSD, 200_000);
  assert.equal(
    pooled['BTC.BTC'][0].amount + pooled['BTC.BTC'][1].amount,
    10
  );
});

test('pooled RUNE uses the same eligible pool rows as exogenous pool depth', () => {
  const pools = [
    { balance_asset: '1000000000', balance_rune: '2000000000' },
    { balance_asset: '500000000', balance_rune: '1500000000' },
    { balance_asset: '0', balance_rune: '9000000000' }
  ];

  assert.equal(getPooledRuneAmount(pools), 35);

  const exogenousValueUSD = 700;
  const effectiveRunePrice = exogenousValueUSD / getPooledRuneAmount(pools);
  const totalPooledUSD = exogenousValueUSD + getPooledRuneAmount(pools) * effectiveRunePrice;
  assert.equal(totalPooledUSD, exogenousValueUSD * 2);
});

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
