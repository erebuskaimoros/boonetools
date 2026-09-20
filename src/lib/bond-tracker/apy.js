import { calculateAPR, calculateAPY } from '../utils/calculations.js';

export const MIN_CHURN_PROGRESS_RATIO = 0.05;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeMinProgressRatio(minProgressRatio) {
  return Math.max(0, Math.min(1, toFiniteNumber(minProgressRatio, MIN_CHURN_PROGRESS_RATIO)));
}

export function getEffectiveChurnPeriodSeconds({
  lastChurnTimestamp,
  churnIntervalSeconds,
  now = Date.now() / 1000,
  minProgressRatio = MIN_CHURN_PROGRESS_RATIO
}) {
  const normalizedNow = toFiniteNumber(now, 0);
  const normalizedLastChurn = toFiniteNumber(lastChurnTimestamp, 0);
  if (normalizedLastChurn <= 0 || normalizedNow <= normalizedLastChurn) return 0;

  const elapsedSeconds = normalizedNow - normalizedLastChurn;
  const normalizedIntervalSeconds = Math.max(0, toFiniteNumber(churnIntervalSeconds, 0));

  return Math.max(elapsedSeconds, normalizedIntervalSeconds * normalizeMinProgressRatio(minProgressRatio));
}

export function getEffectiveChurnProgress({
  progressedBlocks,
  totalBlocks,
  minProgressRatio = MIN_CHURN_PROGRESS_RATIO
}) {
  const normalizedTotalBlocks = Math.max(0, toFiniteNumber(totalBlocks, 0));
  const normalizedProgressedBlocks = Math.max(0, toFiniteNumber(progressedBlocks, 0));
  const progressRatio = normalizedTotalBlocks > 0
    ? normalizedProgressedBlocks / normalizedTotalBlocks
    : 0;
  const normalizedMinProgressRatio = normalizeMinProgressRatio(minProgressRatio);

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
  const normalizedReward = Math.max(0, toFiniteNumber(reward, 0));
  const normalizedPrincipal = Math.max(0, toFiniteNumber(principal, 0));
  const normalizedCompoundingPeriods = toFiniteNumber(compoundingPeriods, 365) > 0
    ? toFiniteNumber(compoundingPeriods, 365)
    : 365;
  const progress = getEffectiveChurnProgress({
    progressedBlocks,
    totalBlocks,
    minProgressRatio
  });
  const normalizedTotalBlocks = Math.max(0, toFiniteNumber(totalBlocks, 0));
  const normalizedProgressedBlocks = Math.max(0, toFiniteNumber(progressedBlocks, 0));
  const normalizedSecondsPerBlock = Math.max(0, toFiniteNumber(secondsPerBlock, 0));
  const blockPeriodSeconds = normalizedTotalBlocks > 0 && normalizedSecondsPerBlock > 0
    ? normalizedTotalBlocks * normalizedSecondsPerBlock
    : 0;
  const elapsedBlockPeriodSeconds = normalizedProgressedBlocks > 0 && normalizedSecondsPerBlock > 0
    ? normalizedProgressedBlocks * normalizedSecondsPerBlock
    : 0;

  if (elapsedBlockPeriodSeconds > 0) {
    // current_award has accrued only since the last payout. Annualize that
    // elapsed period, with a small floor to limit noise immediately after churn.
    const effectivePeriodSeconds = Math.max(
      elapsedBlockPeriodSeconds,
      blockPeriodSeconds * normalizeMinProgressRatio(minProgressRatio)
    );
    const apr = calculateAPR(normalizedReward, normalizedPrincipal, effectivePeriodSeconds);
    const apy = calculateAPY(apr, normalizedCompoundingPeriods);

    return {
      apr,
      apy,
      projectedReward: normalizedReward,
      progressRatio: progress.progressRatio,
      effectiveProgressRatio: progress.effectiveProgressRatio,
      effectivePeriodSeconds,
      isProlonged: blockPeriodSeconds > 0 && elapsedBlockPeriodSeconds > blockPeriodSeconds
    };
  }

  const effectivePeriodSeconds = getEffectiveChurnPeriodSeconds({
    lastChurnTimestamp,
    churnIntervalSeconds,
    now,
    minProgressRatio
  });

  const apr = calculateAPR(normalizedReward, normalizedPrincipal, effectivePeriodSeconds);
  const apy = calculateAPY(apr, normalizedCompoundingPeriods);
  const normalizedIntervalSeconds = Math.max(0, toFiniteNumber(churnIntervalSeconds, 0));

  return {
    apr,
    apy,
    projectedReward: normalizedReward,
    progressRatio: progress.progressRatio,
    effectiveProgressRatio: progress.effectiveProgressRatio,
    effectivePeriodSeconds,
    isProlonged: normalizedIntervalSeconds > 0 && effectivePeriodSeconds > normalizedIntervalSeconds
  };
}
