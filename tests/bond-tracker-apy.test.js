import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateAPR, calculateAPY } from '../src/lib/utils/calculations.js';
import {
  MIN_CHURN_PROGRESS_RATIO,
  getEffectiveChurnProgress,
  getEffectiveChurnPeriodSeconds,
  estimateCurrentChurnYields
} from '../src/lib/bond-tracker/apy.js';

test('block-aware APY projects through the current churn once enough blocks have elapsed', () => {
  const reward = 200;
  const principal = 10_000;
  const estimate = estimateCurrentChurnYields({
    reward,
    principal,
    progressedBlocks: 20,
    totalBlocks: 100,
    secondsPerBlock: 6
  });
  const expectedReward = 1_000;
  const expectedApy = calculateAPY(calculateAPR(expectedReward, principal, 600));

  assert.equal(estimate.projectedReward, expectedReward);
  assert.equal(estimate.effectiveProgressRatio, 0.2);
  assert.equal(estimate.apy, expectedApy);
});

test('very fresh churn APY uses a minimum block-progress floor to avoid exploding projections', () => {
  const estimate = estimateCurrentChurnYields({
    reward: 10,
    principal: 10_000,
    progressedBlocks: 1,
    totalBlocks: 100,
    secondsPerBlock: 6
  });
  const rawBlockApy = calculateAPY(calculateAPR(1_000, 10_000, 600));
  const conservativeApy = calculateAPY(calculateAPR(10, 10_000, 600));

  assert.equal(estimate.projectedReward, 10 / MIN_CHURN_PROGRESS_RATIO);
  assert.equal(estimate.effectiveProgressRatio, MIN_CHURN_PROGRESS_RATIO);
  assert.ok(estimate.apy < rawBlockApy);
  assert.ok(estimate.apy > conservativeApy);
});

test('effective churn period falls back to elapsed time when interval metadata is missing', () => {
  assert.equal(
    getEffectiveChurnPeriodSeconds({
      lastChurnTimestamp: 1_000,
      churnIntervalSeconds: 0,
      now: 1_000 + 900
    }),
    900
  );
});

test('effective churn progress reports both raw and floored progress ratios', () => {
  assert.deepEqual(
    getEffectiveChurnProgress({
      progressedBlocks: 1,
      totalBlocks: 100
    }),
    {
      progressRatio: 0.01,
      effectiveProgressRatio: MIN_CHURN_PROGRESS_RATIO
    }
  );
});
