function pad(value) {
  return String(value).padStart(2, '0');
}

export function getChurnDisplayState(churnStatus = {}, options = {}) {
  if (options.consensusStalled) return 'BLOCKED';
  if (churnStatus.isPaused) return 'PAUSED';
  if (churnStatus.isInProgress) return 'CHURNING';
  return 'ACTIVE';
}

export function formatChurnCountdown(churnStatus = {}, nowMs = Date.now(), options = {}) {
  const state = getChurnDisplayState(churnStatus, options);
  if (state === 'CHURNING') return 'IN PROGRESS';
  if (state !== 'ACTIVE') return state;

  const targetMs = Number(churnStatus.nextChurnTimestampMs);
  if (!Number.isFinite(targetMs) || targetMs <= 0) return '-';

  const remainingSeconds = Math.ceil((targetMs - nowMs) / 1_000);
  if (remainingSeconds <= 0) return 'DUE NOW';

  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}
