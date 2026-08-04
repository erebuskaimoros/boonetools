import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateWasmArbEconomicsBuckets,
  compactWasmArbMonitoringRows,
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
    feesComplete: true,
    oracleComplete: true
  }));
}

const beforeTotals = {
  networkVolumeUsd: 16_502_790.12,
  networkLiquidityFeeUsd: 16_861.6162,
  networkLiquidityFeeRune: 38_000,
  networkSwapLegCount: 60_000,
  wasmActionCount: 2_096,
  wasmLegCount: 3_700,
  wasmInputVolumeUsd: 75_000,
  wasmLegVolumeUsd: 120_130.0273,
  wasmLiquidityFeeUsd: 106.63687,
  wasmLiquidityFeeRune: 240,
  zeroSlipActionCount: 0,
  zeroFeeActionCount: 0,
  belowReferenceActionCount: 0,
  ammFeeUsd: 17.54586,
  finFeeUsd: 226.81572,
  finRangeFeeUsd: 15.42806,
  linkedAmmFeeUsd: 17.54586,
  linkedFinFeeUsd: 199.99342,
  linkedFinRangeFeeUsd: 15.42806
};

const afterTotals = {
  networkVolumeUsd: 20_119_000.71,
  networkLiquidityFeeUsd: 21_211.8039,
  networkLiquidityFeeRune: 48_000,
  networkSwapLegCount: 75_000,
  wasmActionCount: 3_646,
  wasmLegCount: 6_500,
  wasmInputVolumeUsd: 135_000,
  wasmLegVolumeUsd: 222_722.9178,
  wasmLiquidityFeeUsd: 44.31959,
  wasmLiquidityFeeRune: 100,
  zeroSlipActionCount: 2_678,
  zeroFeeActionCount: 1_001,
  belowReferenceActionCount: 3_581,
  ammFeeUsd: 29.16352,
  finFeeUsd: 268.96874,
  finRangeFeeUsd: 25.13919,
  linkedAmmFeeUsd: 29.16352,
  linkedFinFeeUsd: 245.87339,
  linkedFinRangeFeeUsd: 25.13919
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
  const summary = summarizeWasmArbWindow(distributedRows(1_785_161_100, 353, afterTotals));

  assert.equal(Number(summary.linkedRujiraFeeUsd.toFixed(6)), 275.03691);
  assert.equal(Number(summary.linkedTcReserveUsd.toFixed(6)), 137.518455);
  assert.equal(Number(summary.tcLinkedValueUsd.toFixed(6)), 181.838045);
  assert.equal(Number(summary.finRangeFeeUsd.toFixed(6)), 25.13919);
  assert.equal(Number(summary.allRujiraFeeUsd.toFixed(6)), 298.13226);
  assert.equal(Number(summary.tcBroadValueUsd.toFixed(6)), 193.38572);
});

test('oracle completeness requires observations across the selected window', () => {
  const rows = distributedRows(1_785_161_100, 10, afterTotals).map((row, index) => ({
    ...row,
    oracleObservationCount: index === 0 ? 0 : 12,
    oracleAbsDeviationSumBps: index === 0 ? 0 : 120,
    oracleSignedDeviationSumBps: index === 0 ? 0 : -12,
    oracleWeightedAbsNumerator: index === 0 ? 0 : 240,
    oracleDepthWeightUsd: index === 0 ? 0 : 24,
    oracleWithin10Count: index === 0 ? 0 : 8,
    oracleWithin25Count: index === 0 ? 0 : 11
  }));
  const summary = summarizeWasmArbWindow(rows);

  assert.equal(summary.oracleCoverageComplete, true);
  assert.equal(summary.oracleBucketCoverage, 0.9);
  assert.equal(summary.priceTracking.observations, 108);
  assert.equal(summary.priceTracking.depthWeightedAbsoluteDeviationBps, 10);
});

test('equal-window comparison excludes the Mimir transition bucket and reproduces corrected economics', () => {
  const preStart = Date.parse('2026-07-26T08:35:00Z') / 1000;
  const postStart = 1_785_161_100;
  const rows = [
    ...distributedRows(preStart, 353, beforeTotals, { mimirValue: 7 }),
    ...distributedRows(postStart, 353, afterTotals, { mimirValue: 0 })
  ];
  const result = compareWasmArbEqualWindows(rows, {
    anchorTime: '2026-07-27T14:04:45Z',
    windowSeconds: 353 * 300
  });

  assert.equal(result.ready, true);
  assert.equal(result.dataComplete, true);
  assert.equal(result.verdict, 'negative');
  assert.equal(result.bounds.preStart, preStart);
  assert.equal(result.bounds.preEnd, Date.parse('2026-07-27T14:00:00Z') / 1000);
  assert.equal(result.bounds.postStart, postStart);
  assert.equal(Number(result.before.tcLinkedValueUsd.toFixed(6)), 215.40651);
  assert.equal(Number(result.after.tcLinkedValueUsd.toFixed(6)), 181.838045);
  assert.equal(Number(result.deltas.tcLinkedValueUsd.absolute.toFixed(6)), -33.568465);
  assert.equal(Number((result.deltas.tcLinkedValueUsd.percent * 100).toFixed(2)), -15.58);
  assert.equal(Number(result.before.tcPerMillionNetworkVolumeUsd.toFixed(4)), 13.0527);
  assert.equal(Number(result.after.tcPerMillionNetworkVolumeUsd.toFixed(4)), 9.0381);
  assert.equal(Number(result.before.tcPerMillionWasmVolumeUsd.toFixed(2)), 1793.11);
  assert.equal(Number(result.after.tcPerMillionWasmVolumeUsd.toFixed(2)), 816.43);
  assert.equal(Number(result.before.tcBroadValueUsd.toFixed(5)), 228.81766);
  assert.equal(Number(result.after.tcBroadValueUsd.toFixed(5)), 193.38572);
  assert.equal(Number(result.breakEven.breakEvenRujiraIncreaseUsd.toFixed(6)), 124.63456);
  assert.equal(Number((result.breakEven.coverage * 100).toFixed(2)), 46.13);
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

test('monitoring compaction preserves corrected accounting while bounding the public series', () => {
  const start = Date.parse('2026-06-23T00:00:00Z') / 1000;
  const sourceRows = distributedRows(start, 35 * 24 * 12, afterTotals, { mimirValue: 0 });
  const compacted = compactWasmArbMonitoringRows(sourceRows);
  const sourceSummary = summarizeWasmArbWindow(sourceRows);
  const compactSummary = summarizeWasmArbWindow(compacted.rows);

  assert.equal(compacted.sourceRowCount, sourceRows.length);
  assert.ok(compacted.historicalRowCount >= 4);
  assert.ok(compacted.recentRowCount <= 31 * 24);
  assert.ok(compacted.rows.length < sourceRows.length / 10);
  assert.equal(
    Number(compactSummary.tcLinkedValueUsd.toFixed(6)),
    Number(sourceSummary.tcLinkedValueUsd.toFixed(6))
  );
  assert.equal(
    Number(compactSummary.wasmLegVolumeUsd.toFixed(4)),
    Number(sourceSummary.wasmLegVolumeUsd.toFixed(4))
  );
  assert.equal(
    Number(compactSummary.linkedRujiraFeeUsd.toFixed(6)),
    Number(sourceSummary.linkedRujiraFeeUsd.toFixed(6))
  );
  assert.equal(
    Number(compactSummary.finRangeFeeUsd.toFixed(6)),
    Number(sourceSummary.finRangeFeeUsd.toFixed(6))
  );
});

test('chart aggregation preserves additive totals and recomputes value density at every grain', () => {
  const start = Date.parse('2026-07-27T00:00:00Z') / 1000;
  const sourceRows = distributedRows(start, 2 * 24 * 12, afterTotals, { mimirValue: 0 });
  const sourceSummary = summarizeWasmArbWindow(sourceRows);
  const expectedBucketCounts = new Map([
    [60 * 60, 48],
    [24 * 60 * 60, 2],
    [7 * 24 * 60 * 60, 1]
  ]);

  for (const grainSeconds of [60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60]) {
    const buckets = aggregateWasmArbEconomicsBuckets(sourceRows, grainSeconds);
    const bucketSummary = summarizeWasmArbWindow(buckets);

    assert.equal(buckets.length, expectedBucketCounts.get(grainSeconds));
    assert.equal(
      Number(bucketSummary.tcLinkedValueUsd.toFixed(6)),
      Number(sourceSummary.tcLinkedValueUsd.toFixed(6))
    );
    assert.equal(
      Number(bucketSummary.wasmLegVolumeUsd.toFixed(4)),
      Number(sourceSummary.wasmLegVolumeUsd.toFixed(4))
    );
    assert.equal(
      Number(bucketSummary.tcPerMillionWasmVolumeUsd.toFixed(6)),
      Number(sourceSummary.tcPerMillionWasmVolumeUsd.toFixed(6))
    );
  }

  const [weeklyBucket] = aggregateWasmArbEconomicsBuckets(
    sourceRows,
    7 * 24 * 60 * 60
  );
  assert.equal(weeklyBucket.bucketStart, '2026-07-27T00:00:00.000Z');
});

test('hourly charts retain compacted daily rows at their honest source grain', () => {
  const [dailyRow] = distributedRows(
    Date.parse('2026-06-23T00:00:00Z') / 1000,
    1,
    afterTotals,
    { mimirValue: 0 }
  );
  dailyRow.bucketSeconds = 24 * 60 * 60;

  const [bucket] = aggregateWasmArbEconomicsBuckets([dailyRow], 60 * 60);

  assert.equal(bucket.bucketSeconds, 24 * 60 * 60);
  assert.equal(bucket.observedSeconds, 24 * 60 * 60);
  assert.equal(bucket.partial, false);
  assert.equal(Number(bucket.tcLinkedValueUsd.toFixed(6)), 181.838045);
});
