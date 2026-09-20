import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateAPR, calculateAPY } from '../src/lib/utils/calculations.js';
import {
  MIN_CHURN_PROGRESS_RATIO,
  getEffectiveChurnProgress,
  getEffectiveChurnPeriodSeconds,
  estimateCurrentChurnYields
} from '../src/lib/bond-tracker/apy.js';

test('block-aware APY annualizes accrued award over elapsed blocks before churn is due', () => {
  const reward = 2;
  const principal = 1_000_000;
  const estimate = estimateCurrentChurnYields({
    reward,
    principal,
    progressedBlocks: 20,
    totalBlocks: 100,
    secondsPerBlock: 6
  });
  const expectedApy = calculateAPY(calculateAPR(reward, principal, 120));

  assert.equal(estimate.projectedReward, reward);
  assert.equal(estimate.effectiveProgressRatio, 0.2);
  assert.equal(estimate.effectivePeriodSeconds, 120);
  assert.equal(estimate.apy, expectedApy);
});

test('very fresh churn APY floors elapsed time at 5% of the interval', () => {
  const estimate = estimateCurrentChurnYields({
    reward: 0.1,
    principal: 1_000_000,
    progressedBlocks: 1,
    totalBlocks: 100,
    secondsPerBlock: 6
  });
  const elapsedBlockApy = calculateAPY(calculateAPR(0.1, 1_000_000, 6));
  const flooredApy = calculateAPY(calculateAPR(0.1, 1_000_000, 30));

  assert.equal(estimate.projectedReward, 0.1);
  assert.equal(estimate.effectiveProgressRatio, MIN_CHURN_PROGRESS_RATIO);
  assert.equal(estimate.effectivePeriodSeconds, 30);
  assert.equal(estimate.apy, flooredApy);
  assert.ok(estimate.apy < elapsedBlockApy);
});

test('prolonged churn APY annualizes over actual elapsed blocks instead of nominal churn interval', () => {
  const estimate = estimateCurrentChurnYields({
    reward: 3,
    principal: 1_000_000,
    progressedBlocks: 150,
    totalBlocks: 100,
    secondsPerBlock: 6
  });
  const nominalApy = calculateAPY(calculateAPR(3, 1_000_000, 600));
  const expectedApy = calculateAPY(calculateAPR(3, 1_000_000, 900));

  assert.equal(estimate.projectedReward, 3);
  assert.equal(estimate.progressRatio, 1.5);
  assert.equal(estimate.effectivePeriodSeconds, 900);
  assert.equal(estimate.isProlonged, true);
  assert.equal(estimate.apy, expectedApy);
  assert.ok(estimate.apy < nominalApy);
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

test('timestamp fallback uses the same early-period floor and prolonged elapsed time', () => {
  const input = {
    reward: 10,
    principal: 100_000,
    lastChurnTimestamp: 1_000,
    churnIntervalSeconds: 10_000
  };
  const early = estimateCurrentChurnYields({ ...input, now: 1_100 });
  const prolonged = estimateCurrentChurnYields({ ...input, now: 16_000 });

  assert.equal(early.effectivePeriodSeconds, 500);
  assert.equal(early.apy, calculateAPY(calculateAPR(10, 100_000, 500)));
  assert.equal(early.isProlonged, false);
  assert.equal(prolonged.effectivePeriodSeconds, 15_000);
  assert.equal(prolonged.isProlonged, true);
});

test('valid elapsed blocks work without interval metadata and take precedence over timestamps', () => {
  const estimate = estimateCurrentChurnYields({
    reward: 10,
    principal: 100_000,
    progressedBlocks: 100,
    secondsPerBlock: 6,
    lastChurnTimestamp: 1_000,
    now: 10_000
  });

  assert.equal(estimate.effectivePeriodSeconds, 600);
  assert.equal(estimate.isProlonged, false);
  assert.equal(estimate.apy, calculateAPY(calculateAPR(10, 100_000, 600)));
});

test('missing block progress falls back to a valid timestamp', () => {
  const estimate = estimateCurrentChurnYields({
    reward: 10,
    principal: 100_000,
    progressedBlocks: 0,
    totalBlocks: 100,
    secondsPerBlock: 6,
    lastChurnTimestamp: 1_000,
    churnIntervalSeconds: 600,
    now: 1_300
  });

  assert.equal(estimate.effectivePeriodSeconds, 300);
  assert.equal(estimate.apy, calculateAPY(calculateAPR(10, 100_000, 300)));
});

test('unknown, zero, invalid, or future timestamps do not invent an accrual period', () => {
  for (const lastChurnTimestamp of [undefined, null, 0, -1, NaN, Infinity, 'invalid', 10_000, 10_001]) {
    const estimate = estimateCurrentChurnYields({
      reward: 10,
      principal: 100_000,
      progressedBlocks: 0,
      totalBlocks: 100,
      secondsPerBlock: 6,
      lastChurnTimestamp,
      churnIntervalSeconds: 600,
      now: 10_000
    });

    assert.equal(estimate.effectivePeriodSeconds, 0, String(lastChurnTimestamp));
    assert.equal(estimate.apr, 0);
    assert.equal(estimate.apy, 0);
    assert.equal(estimate.projectedReward, 10);
  }
});

test('invalid time, reward, principal, and compounding inputs produce safe yields', () => {
  const input = { reward: 10, principal: 100_000, progressedBlocks: 100, totalBlocks: 100, secondsPerBlock: 6 };
  for (const invalidValue of [undefined, null, 0, -1, NaN, Infinity, 'invalid']) {
    assert.equal(estimateCurrentChurnYields({ ...input, reward: invalidValue }).apy, 0);
    assert.equal(estimateCurrentChurnYields({ ...input, principal: invalidValue }).apy, 0);
    assert.equal(estimateCurrentChurnYields({ ...input, secondsPerBlock: invalidValue }).apy, 0);
    assert.equal(
      estimateCurrentChurnYields({ ...input, compoundingPeriods: invalidValue }).apy,
      calculateAPY(calculateAPR(10, 100_000, 600))
    );
  }
  for (const now of [null, 0, -1, NaN, Infinity, 'invalid']) {
    assert.equal(getEffectiveChurnPeriodSeconds({ lastChurnTimestamp: 1_000, now }), 0);
  }
});

test('a custom early-period floor applies consistently to blocks and timestamps', () => {
  const input = { reward: 10, principal: 100_000, minProgressRatio: 0.1 };
  const blocks = estimateCurrentChurnYields({ ...input, progressedBlocks: 1, totalBlocks: 100, secondsPerBlock: 6 });
  const timestamps = estimateCurrentChurnYields({ ...input, lastChurnTimestamp: 1_000, churnIntervalSeconds: 600, now: 1_006 });

  assert.equal(blocks.effectivePeriodSeconds, 60);
  assert.equal(timestamps.effectivePeriodSeconds, 60);
  assert.equal(blocks.apy, timestamps.apy);
});
