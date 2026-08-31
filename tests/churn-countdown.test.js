import assert from 'node:assert/strict';
import test from 'node:test';

import { formatChurnCountdown } from '../src/lib/status/churn-countdown.js';

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
