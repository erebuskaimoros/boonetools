import { calculateAPR, calculateAPY } from '../utils/calculations.js';

export const MIN_CHURN_PROGRESS_RATIO = 0.05;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function getEffectiveChurnPeriodSeconds({ lastChurnTimestamp, churnIntervalSeconds, now = Date.now() / 1000 }) {
  const normalizedNow = toFiniteNumber(now, Date.now() / 1000);
  const normalizedLastChurn = toFiniteNumber(lastChurnTimestamp, 0);
  const elapsedSeconds = Math.max(0, normalizedNow - normalizedLastChurn);
  const normalizedIntervalSeconds = Math.max(0, toFiniteNumber(churnIntervalSeconds, 0));

  return normalizedIntervalSeconds > 0
    ? Math.max(elapsedSeconds, normalizedIntervalSeconds)
    : elapsedSeconds;
}

export function getEffectiveChurnProgress({
  progressedBlocks,
  totalBlocks,
  minProgressRatio = MIN_CHURN_PROGRESS_RATIO
}) {
  const normalizedTotalBlocks = Math.max(0, toFiniteNumber(totalBlocks, 0));
  const normalizedProgressedBlocks = Math.max(
    0,
    Math.min(normalizedTotalBlocks, toFiniteNumber(progressedBlocks, 0))
  );
  const progressRatio = normalizedTotalBlocks > 0
    ? normalizedProgressedBlocks / normalizedTotalBlocks
    : 0;
  const normalizedMinProgressRatio = Math.max(
    0,
    Math.min(1, toFiniteNumber(minProgressRatio, MIN_CHURN_PROGRESS_RATIO))
  );

  return {
    progressRatio,
    effectiveProgressRatio: progressRatio > 0
      ? Math.max(progressRatio, normalizedMinProgressRatio)
      : 0
  };
}

export function estimateCurrentChurnYields({
  reward,
  principal,
  progressedBlocks,
  totalBlocks,
  secondsPerBlock,
  minProgressRatio = MIN_CHURN_PROGRESS_RATIO,
  lastChurnTimestamp,
  churnIntervalSeconds,
  now = Date.now() / 1000,
  compoundingPeriods = 365
}) {
  const normalizedReward = toFiniteNumber(reward, 0);
  const progress = getEffectiveChurnProgress({
    progressedBlocks,
    totalBlocks,
    minProgressRatio
  });
  const normalizedTotalBlocks = Math.max(0, toFiniteNumber(totalBlocks, 0));
  const normalizedSecondsPerBlock = Math.max(0, toFiniteNumber(secondsPerBlock, 0));
  const blockPeriodSeconds = normalizedTotalBlocks > 0 && normalizedSecondsPerBlock > 0
    ? normalizedTotalBlocks * normalizedSecondsPerBlock
    : 0;

  if (progress.effectiveProgressRatio > 0 && blockPeriodSeconds > 0) {
    const projectedReward = normalizedReward / progress.effectiveProgressRatio;
    const apr = calculateAPR(projectedReward, principal, blockPeriodSeconds);
    const apy = calculateAPY(apr, compoundingPeriods);

    return {
      apr,
      apy,
      projectedReward,
      progressRatio: progress.progressRatio,
      effectiveProgressRatio: progress.effectiveProgressRatio,
      effectivePeriodSeconds: blockPeriodSeconds
    };
  }

  const effectivePeriodSeconds = getEffectiveChurnPeriodSeconds({
    lastChurnTimestamp,
    churnIntervalSeconds,
    now
  });

  const apr = calculateAPR(normalizedReward, principal, effectivePeriodSeconds);
  const apy = calculateAPY(apr, compoundingPeriods);

  return {
    apr,
    apy,
    projectedReward: normalizedReward,
    progressRatio: progress.progressRatio,
    effectiveProgressRatio: progress.effectiveProgressRatio,
    effectivePeriodSeconds
  };
}
