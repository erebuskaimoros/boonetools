import assert from 'node:assert/strict';
import test from 'node:test';
import { financialDayStatus } from '../src/lib/financials/day-status.js';

test('pending status distinguishes saved exclusions from live state and targeted checks from a day scan', () => {
  const status = financialDayStatus({ pendingSwaps: 231, unpricedSwaps: 2,
    settlement: { status: 'pending', checkedAt: '2026-10-24T01:15:00Z', nextCheckAt: '2026-10-24T02:15:00Z', remaining: 231 } });
  assert.match(status.warning, /231 swaps last seen pending/);
  assert.match(status.warning, /saved Midgard status, not a live on-chain count/);
  assert.match(status.warning, /2 unpriced/);
  assert.match(status.warning, /Unpriced swaps are not automatically retried/);
  assert.match(status.settlement, /Only saved pending IDs are rechecked/);
  assert.match(status.settlement, /day is not rescanned/);
  assert.match(status.settlement, /Last complete pending-ID check: 2026-10-24 01:15:00 UTC/);
  assert.match(status.settlement, /Next pending-ID check scheduled for 2026-10-24 02:15:00 UTC/);
  assert.equal(status.pauseLabel, 'Settlement checks paused');
});

test('an in-progress first pass does not claim all pending IDs have already been checked', () => {
  const status = financialDayStatus({ pendingSwaps: 2, observedAt: '2026-10-24T01:00:00Z',
    settlement: { status: 'pending', checkedAt: null, nextCheckAt: null, remaining: 2 } });
  assert.match(status.settlement, /First complete pending-ID check has not finished/);
  assert.doesNotMatch(status.settlement, /Last complete|2026-10-24|scheduled/);
});

test('incomplete and missing retained IDs stay disclosed without promising automatic recovery', () => {
  const incomplete = financialDayStatus({ pendingSwaps: 8, exclusionsIncomplete: true,
    settlement: { status: 'pending', checkedAt: null, remaining: 3 } });
  assert.match(incomplete.warning, /Some excluded transaction IDs were not retained/);
  assert.match(incomplete.warning, /those exclusions cannot be rechecked automatically/);
  const unavailable = financialDayStatus({ pendingSwaps: 8,
    settlement: { status: 'unavailable', checkedAt: null, remaining: 0 } });
  assert.match(unavailable.warning, /No retained pending IDs are available for automatic rechecks/);
  assert.match(unavailable.settlement, /Automatic pending-ID checks unavailable/);
  assert.doesNotMatch(unavailable.settlement, /Only saved pending IDs are rechecked|scheduled/);
});

test('completed checks do not imply unpriced or incomplete rankings became financially final', () => {
  const status = financialDayStatus({ unpricedSwaps: 1, pendingSwaps: 0,
    settlement: { status: 'complete', checkedAt: '2026-10-24T01:15:00Z', nextCheckAt: null, remaining: 0 } });
  assert.match(status.warning, /Provisional snapshot/);
  assert.match(status.warning, /1 unpriced/);
  assert.match(status.settlement, /Saved pending-ID checks complete/);
  assert.doesNotMatch(status.settlement, /finalized|permanent|Only saved pending IDs are rechecked/);
  assert.equal(financialDayStatus({ settlement: { status: 'complete' } }).warning, '');
});

test('old backend snapshots remain honest about unavailable settlement metadata', () => {
  const status = financialDayStatus({ pendingSwaps: 231, observedAt: '2026-10-24T00:22:35Z' });
  assert.match(status.warning, /No settlement-check status is available for this saved snapshot/);
  assert.equal(status.settlement, '');
  assert.equal(status.pauseLabel, 'Acquisition paused');
  assert.equal(financialDayStatus({ progress: { phase: 'settlement' } }).pauseLabel, 'Settlement checks paused');
  assert.deepEqual(financialDayStatus(null), { warning: '', settlement: '', pauseLabel: 'Acquisition paused' });
});

test('invalid settlement dates never render Invalid Date or claim a scheduled pass', () => {
  const status = financialDayStatus({ pendingSwaps: 1,
    settlement: { status: 'pending', checkedAt: 'bad', nextCheckAt: 'bad' } });
  assert.doesNotMatch(status.settlement, /Invalid Date|scheduled|Last complete/);
});
