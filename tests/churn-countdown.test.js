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

test('Thorfolio churn timing comes from live status with the observed block average', async () => {
  const { churnStateFromStatusLive } = await import('../src/lib/utils/nodes.js');
  const lastChurnMs = Date.parse('2026-10-11T12:00:00Z');
  const live = { network: { height: 28_215_000, consensus: { last_block_at: new Date(lastChurnMs + 10_000 * 6_200).toISOString() } },
    churn: { isPaused: false, estimated: false, lastChurnHeight: 28_205_000, lastChurnTimestampMs: lastChurnMs,
      nextChurnHeight: 28_248_200, churnIntervalBlocks: 43_200 } };
  const state = churnStateFromStatusLive({ data: live });
  assert.equal(state.secondsPerBlock, 6.2);
  assert.equal(state.currentHeight, 28_215_000);
  assert.equal(state.blocksRemaining, 33_200);
  assert.equal(state.nextChurnTimestamp, lastChurnMs / 1000 + 43_200 * 6.2);
  // Estimated or incomplete churn data falls back to direct provider reads.
  assert.equal(churnStateFromStatusLive({ ...live, churn: { ...live.churn, estimated: true } }), null);
  assert.equal(churnStateFromStatusLive({ ...live, network: { height: 28_205_000 } }), null);
});
