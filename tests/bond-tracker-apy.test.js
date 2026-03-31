import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateAPR, calculateAPY } from '../src/lib/utils/calculations.js';
import {
  getEffectiveChurnPeriodSeconds,
  estimateCurrentChurnYields
} from '../src/lib/bond-tracker/apy.js';

test('fresh churn APY uses the full churn interval instead of the first few elapsed seconds', () => {
  const reward = 250;
  const principal = 10_000;
  const lastChurnTimestamp = 1_000;
  const churnIntervalSeconds = 86_400;
  const now = lastChurnTimestamp + 3_600;

  const oldApy = calculateAPY(calculateAPR(reward, principal, now - lastChurnTimestamp));
  const estimate = estimateCurrentChurnYields({
    reward,
    principal,
    lastChurnTimestamp,
    churnIntervalSeconds,
    now
  });

  assert.equal(estimate.effectivePeriodSeconds, churnIntervalSeconds);
  assert.ok(estimate.apy < oldApy);
});

test('mature churn APY falls back to actual elapsed time once the interval has passed', () => {
  const estimate = estimateCurrentChurnYields({
    reward: 250,
    principal: 10_000,
    lastChurnTimestamp: 1_000,
    churnIntervalSeconds: 3_600,
    now: 1_000 + 7_200
  });

  assert.equal(estimate.effectivePeriodSeconds, 7_200);
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
