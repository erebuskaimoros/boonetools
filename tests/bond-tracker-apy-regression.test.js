import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCurrentChurnYields } from '../src/lib/bond-tracker/apy.js';

// THORNode current_award is the node's share of rewards accrued since the
// previous payout, not a projection of the full upcoming churn's rewards.
test('steady reward accrual has the same APY midway through a churn as at its end', () => {
  const input = { principal: 100_000, totalBlocks: 43_200, secondsPerBlock: 6 };
  const halfway = estimateCurrentChurnYields({ ...input, progressedBlocks: 21_600, reward: 50 });
  const complete = estimateCurrentChurnYields({ ...input, progressedBlocks: 43_200, reward: 100 });

  assert.equal(halfway.projectedReward, 50, 'keep the actual accrued award intact');
  assert.equal(halfway.effectivePeriodSeconds, 21_600 * 6);
  assert.equal(halfway.apy, complete.apy);
});

test('timestamp fallback annualizes accrued rewards over elapsed time too', () => {
  const input = { principal: 100_000, lastChurnTimestamp: 1_000, churnIntervalSeconds: 259_200 };
  const halfway = estimateCurrentChurnYields({ ...input, now: 130_600, reward: 50 });
  const complete = estimateCurrentChurnYields({ ...input, now: 260_200, reward: 100 });

  assert.equal(halfway.effectivePeriodSeconds, 129_600);
  assert.equal(halfway.apy, complete.apy);
});
