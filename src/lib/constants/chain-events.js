const THORCHAIN_2026_HACK_HALT_START_MS = Date.parse('2026-05-16T00:00:00.000Z');
const THORCHAIN_2026_HACK_HALT_END_MS = Date.parse('2026-06-22T00:00:00.000Z');

export const THORCHAIN_2026_HACK_HALT_LABEL = 'Chain halt';

function eventTimeMs(value) {
  if (value instanceof Date) return value.getTime();

  const numeric = Number(value);
  if (Number.isFinite(numeric) && value !== '' && value !== null) {
    return Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  return Date.parse(String(value || ''));
}

/**
 * The chain was offline after the May 15, 2026 exploit and resumed on June 22.
 * The interval is start-inclusive and end-exclusive so both active boundary days
 * remain available to analytics.
 */
export function isThorchain2026HackHalt(value) {
  const timestamp = eventTimeMs(value);
  return Number.isFinite(timestamp) &&
    timestamp >= THORCHAIN_2026_HACK_HALT_START_MS &&
    timestamp < THORCHAIN_2026_HACK_HALT_END_MS;
}
