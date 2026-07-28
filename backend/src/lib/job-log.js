const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_ERROR_STACK_LENGTH = 4_000;

function boundedText(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function normalizedDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;
}

export function createJobCompletionLog(job, durationMs) {
  return JSON.stringify({
    type: 'job_completed',
    job,
    duration_ms: normalizedDuration(durationMs)
  });
}

export function createJobFailureLog(job, error, durationMs) {
  return JSON.stringify({
    type: 'job_failed',
    job,
    duration_ms: normalizedDuration(durationMs),
    error: boundedText(error?.message || error, MAX_ERROR_MESSAGE_LENGTH),
    stack: boundedText(error?.stack, MAX_ERROR_STACK_LENGTH)
  });
}
