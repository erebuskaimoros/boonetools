import { calculateAPR, calculateAPY } from '../utils/calculations.js';

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

export function estimateCurrentChurnYields({
  reward,
  principal,
  lastChurnTimestamp,
  churnIntervalSeconds,
  now = Date.now() / 1000,
  compoundingPeriods = 365
}) {
  const effectivePeriodSeconds = getEffectiveChurnPeriodSeconds({
    lastChurnTimestamp,
    churnIntervalSeconds,
    now
  });

  const apr = calculateAPR(reward, principal, effectivePeriodSeconds);
  const apy = calculateAPY(apr, compoundingPeriods);

  return {
    apr,
    apy,
    effectivePeriodSeconds
  };
}
