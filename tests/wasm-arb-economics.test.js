import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareWasmArbEqualWindows,
  normalizeWasmArbEconomicsBucket,
  summarizeWasmArbWindow
} from '../shared/wasm-arb-economics/model.js';

function distributedRows(start, count, totals, options = {}) {
  return Array.from({ length: count }, (_, index) => ({
    bucketStart: new Date((start + index * 300) * 1000).toISOString(),
    bucketSeconds: 300,
    networkVolumeUsd: totals.networkVolumeUsd / count,
    networkLiquidityFeeUsd: totals.networkLiquidityFeeUsd / count,
    networkLiquidityFeeRune: totals.networkLiquidityFeeRune / count,
    networkSwapLegCount: totals.networkSwapLegCount / count,
    wasmActionCount: totals.wasmActionCount / count,
    wasmLegCount: totals.wasmLegCount / count,
    wasmInputVolumeUsd: totals.wasmInputVolumeUsd / count,
    wasmLegVolumeUsd: totals.wasmLegVolumeUsd / count,
    wasmLiquidityFeeUsd: totals.wasmLiquidityFeeUsd / count,
    wasmLiquidityFeeRune: totals.wasmLiquidityFeeRune / count,
    zeroSlipActionCount: (totals.zeroSlipActionCount || 0) / count,
    zeroFeeActionCount: (totals.zeroFeeActionCount || 0) / count,
    belowReferenceActionCount: (totals.belowReferenceActionCount || 0) / count,
    ammFeeUsd: totals.ammFeeUsd / count,
    finFeeUsd: totals.finFeeUsd / count,
    finRangeFeeUsd: totals.finRangeFeeUsd / count,
    linkedAmmFeeUsd: totals.linkedAmmFeeUsd / count,
    linkedFinFeeUsd: totals.linkedFinFeeUsd / count,
    linkedFinRangeFeeUsd: totals.linkedFinRangeFeeUsd / count,
    rujiraFeeEventCount: 1,
    unpricedRujiraFeeEventCount: 0,
    tcShare: 0.5,
    mimirValue: options.mimirValue ?? 0,
    referenceMimirValue: 7,
    networkComplete: true,
    actionsComplete: true,
    feesComplete: true
  }));
}

const beforeTotals = {
  networkVolumeUsd: 9_264_198.89,
  networkLiquidityFeeUsd: 9_490.8221985,
  networkLiquidityFeeRune: 21_926.33539319,
  networkSwapLegCount: 35_750,
  wasmActionCount: 1_436,
  wasmLegCount: 2_657,
  wasmInputVolumeUsd: 51_348.88986,
  wasmLegVolumeUsd: 83_511.36196,
  wasmLiquidityFeeUsd: 79.35973308,
  wasmLiquidityFeeRune: 183.0059479,
  zeroSlipActionCount: 0,
  zeroFeeActionCount: 0,
  belowReferenceActionCount: 0,
  ammFeeUsd: 7.439835,
  finFeeUsd: 154.884194,
  finRangeFeeUsd: 6.905009,
  linkedAmmFeeUsd: 7.439835,
  linkedFinFeeUsd: 131.403252,
  linkedFinRangeFeeUsd: 6.905009
};

const afterTotals = {
  networkVolumeUsd: 14_102_026.05,
  networkLiquidityFeeUsd: 15_023.5720739,
  networkLiquidityFeeRune: 34_637.84062717,
  networkSwapLegCount: 44_501,
  wasmActionCount: 2_337,
  wasmLegCount: 4_306,
  wasmInputVolumeUsd: 73_808.85691,
  wasmLegVolumeUsd: 138_155.38724,
  wasmLiquidityFeeUsd: 32.17802615,
  wasmLiquidityFeeRune: 74.04540743,
  zeroSlipActionCount: 1_693,
  zeroFeeActionCount: 654,
  belowReferenceActionCount: 2_285,
  ammFeeUsd: 9.252612,
  finFeeUsd: 148.552742,
  finRangeFeeUsd: 6.89169,
  linkedAmmFeeUsd: 9.252612,
  linkedFinFeeUsd: 133.432174,
  linkedFinRangeFeeUsd: 6.89169
};

test('normalizes snake-case economics buckets without losing zero values', () => {
  const row = normalizeWasmArbEconomicsBucket({
    bucket_start: '2026-07-27T14:05:00Z',
    network_volume_usd: '100',
    wasm_action_count: '2',
    median_slip_bps: '0',
    tc_share: '0.5'
  });

  assert.equal(row.networkVolumeUsd, 100);
  assert.equal(row.wasmActionCount, 2);
  assert.equal(row.medianSlipBps, 0);
  assert.equal(row.tcShare, 0.5);
});

test('summary keeps FIN range fees as a subset and applies the TC collector share once', () => {
  const summary = summarizeWasmArbWindow(distributedRows(1_785_161_100, 235, afterTotals));

  assert.equal(Number(summary.linkedRujiraFeeUsd.toFixed(6)), 142.684786);
  assert.equal(Number(summary.linkedTcReserveUsd.toFixed(6)), 71.342393);
  assert.equal(Number(summary.tcLinkedValueUsd.toFixed(6)), 103.520419);
  assert.equal(Number(summary.finRangeFeeUsd.toFixed(6)), 6.89169);
  assert.equal(Number(summary.allRujiraFeeUsd.toFixed(6)), 157.805354);
});

test('equal-window comparison excludes the Mimir transition bucket and reproduces corrected economics', () => {
  const preStart = 1_785_090_300;
  const postStart = 1_785_161_100;
  const rows = [
    ...distributedRows(preStart, 235, beforeTotals, { mimirValue: 7 }),
    ...distributedRows(postStart, 235, afterTotals, { mimirValue: 0 })
  ];
  const result = compareWasmArbEqualWindows(rows, {
    anchorTime: '2026-07-27T14:04:45Z',
    windowSeconds: 235 * 300
  });

  assert.equal(result.ready, true);
  assert.equal(result.dataComplete, true);
  assert.equal(result.verdict, 'negative');
  assert.equal(result.bounds.preStart, preStart);
  assert.equal(result.bounds.preEnd, 1_785_160_800);
  assert.equal(result.bounds.postStart, postStart);
  assert.equal(Number(result.before.tcLinkedValueUsd.toFixed(6)), 148.781277);
  assert.equal(Number(result.after.tcLinkedValueUsd.toFixed(6)), 103.520419);
  assert.equal(Number(result.deltas.tcLinkedValueUsd.absolute.toFixed(6)), -45.260857);
  assert.equal(Number((result.deltas.tcLinkedValueUsd.percent * 100).toFixed(2)), -30.42);
  assert.equal(Number(result.before.tcPerMillionNetworkVolumeUsd.toFixed(4)), 16.0598);
  assert.equal(Number(result.after.tcPerMillionNetworkVolumeUsd.toFixed(4)), 7.3408);
  assert.equal(Number(result.breakEven.breakEvenRujiraIncreaseUsd.toFixed(6)), 94.363414);
  assert.equal(Number((result.breakEven.coverage * 100).toFixed(2)), 4.07);
});

test('comparison refuses to issue a verdict when a source window has gaps', () => {
  const rows = [
    ...distributedRows(1_785_090_300, 234, beforeTotals),
    ...distributedRows(1_785_161_100, 235, afterTotals)
  ];
  const result = compareWasmArbEqualWindows(rows, {
    anchorTime: '2026-07-27T14:04:45Z',
    windowSeconds: 235 * 300,
    minimumCoverage: 0.999
  });

  assert.equal(result.ready, false);
  assert.match(result.reason, /backfilling/i);
});
