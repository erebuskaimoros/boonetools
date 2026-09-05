import assert from 'node:assert/strict';
import test from 'node:test';

import { formatChurnCountdown, getChurnDisplayState } from '../src/lib/status/churn-countdown.js';

test('next-churn countdown keeps seconds visible across multi-day ETAs', () => {
  const now = Date.UTC(2026, 7, 31, 12);
  assert.equal(formatChurnCountdown({
    nextChurnTimestampMs: now + (((2 * 86_400) + 3_661) * 1_000)
  }, now), '2d 01:01:01');
});

test('next-churn countdown communicates states that cannot count down', () => {
  const now = Date.UTC(2026, 7, 31, 12);
  const target = { nextChurnTimestampMs: now + 60_000 };

  assert.equal(formatChurnCountdown(target, now, { consensusStalled: true }), 'BLOCKED');
  assert.equal(formatChurnCountdown({ ...target, isInProgress: true }, now), 'IN PROGRESS');
  assert.equal(formatChurnCountdown({ ...target, isPaused: true }, now), 'PAUSED');
  assert.equal(formatChurnCountdown({ nextChurnTimestampMs: now - 1 }, now), 'DUE NOW');
  assert.equal(formatChurnCountdown({}, now), '-');
});

test('halted churn takes precedence over in-progress migration or keygen evidence', () => {
  assert.equal(formatChurnCountdown({ isPaused: true, isInProgress: true, mimirValue: 1 }), 'PAUSED');
  assert.equal(getChurnDisplayState({ isPaused: true, isInProgress: true, mimirValue: 1 }), 'PAUSED');
});

test('churn status presentation preserves consensus blocking and ordinary active churn', () => {
  assert.equal(getChurnDisplayState({ isPaused: true, isInProgress: true }, { consensusStalled: true }), 'BLOCKED');
  assert.equal(formatChurnCountdown({ isPaused: true, isInProgress: true }, Date.now(), { consensusStalled: true }), 'BLOCKED');
  assert.equal(getChurnDisplayState({ isInProgress: true }), 'CHURNING');
  assert.equal(getChurnDisplayState({}), 'ACTIVE');
});
