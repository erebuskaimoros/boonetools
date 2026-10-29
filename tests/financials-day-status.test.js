import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLocalDateTime } from '../src/lib/utils/datetime.js';
import { financialDayStatus } from '../src/lib/financials/day-status.js';

test('saved swap verification explains a budget pause rather than promising an immediate scheduled check', () => {
  const retryAt = '2026-10-30T00:00:00.000Z';
  const status = financialDayStatus({ swapSource: 'finalized-block-ledger', swapRankingBasis: 'pool-liquidity-fees-usd',
    pendingSwaps: 25, settlement: { status: 'pending', checkedAt: null, nextCheckAt: retryAt,
      deferred: true, deferredReason: 'request-budget' } });
  assert.match(status.warning, /25 swaps awaiting completion or verification/);
  assert.match(status.settlement, /verification.*paused|checks.*paused/i);
  assert.match(status.settlement, /shared request budget/i);
  assert.ok(status.settlement.includes(`Earliest retry: ${formatLocalDateTime(retryAt)}`));
  assert.doesNotMatch(status.settlement, /Next candidate check scheduled/);
});

test('provider cooldown preserves the last candidate check without promising a scheduled retry', () => {
  const checkedAt = '2026-10-29T16:00:00Z';
  const retryAt = '2026-10-29T16:05:00Z';
  const status = financialDayStatus({ swapSource: 'finalized-block-ledger', pendingSwaps: 3,
    settlement: { status: 'pending', checkedAt, nextCheckAt: retryAt, deferred: true,
      deferredReason: 'provider-cooldown' } });
  assert.match(status.settlement, /Verification checks paused while the data provider is cooling down/);
  assert.ok(status.settlement.includes(`Latest candidate check: ${formatLocalDateTime(checkedAt)}`));
  assert.ok(status.settlement.includes(`Earliest retry: ${formatLocalDateTime(retryAt)}`));
  assert.doesNotMatch(status.settlement, /scheduled|No completed candidate checks|request budget/);
});

test('unknown deferral reason or invalid retry time does not invent a cause or retry promise', () => {
  const status = financialDayStatus({ pendingSwaps: 1,
    settlement: { status: 'pending', nextCheckAt: 'invalid', deferred: true, deferredReason: 'unknown' } });
  assert.match(status.settlement, /Verification checks are paused/);
  assert.doesNotMatch(status.settlement, /request budget|cooling down|Earliest retry|scheduled|Invalid Date/);
});

test('completed checks ignore leftover deferral metadata', () => {
  const status = financialDayStatus({ swapSource: 'finalized-block-ledger',
    settlement: { status: 'complete', checkedAt: '2026-10-29T16:00:00Z',
      nextCheckAt: '2026-10-30T00:00:00Z', deferred: true, deferredReason: 'request-budget' } });
  assert.match(status.settlement, /Saved swap candidate checks complete/);
  assert.match(status.settlement, /Latest candidate check/);
  assert.doesNotMatch(status.settlement, /paused|Earliest retry|scheduled|request budget/);
});

test('pending status distinguishes saved exclusions from live state and targeted checks from a day scan', () => {
  const status = financialDayStatus({ pendingSwaps: 231, unpricedSwaps: 2,
    settlement: { status: 'pending', checkedAt: '2026-10-24T01:15:00Z', nextCheckAt: '2026-10-24T02:15:00Z', remaining: 231 } });
  assert.match(status.warning, /231 swaps last seen pending/);
  assert.match(status.warning, /saved Midgard status, not a live on-chain count/);
  assert.match(status.warning, /2 unpriced/);
  assert.match(status.warning, /Unpriced swaps are not automatically retried/);
  assert.match(status.settlement, /Only saved pending IDs are rechecked/);
  assert.match(status.settlement, /day is not rescanned/);
  assert.ok(status.settlement.includes(`Last complete pending-ID check: ${formatLocalDateTime('2026-10-24T01:15:00Z')}`));
  assert.ok(status.settlement.includes(`Next pending-ID check scheduled for ${formatLocalDateTime('2026-10-24T02:15:00Z')}`));
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

test('fee-ledger status distinguishes unverified candidates and missing pricing from Midgard pending actions', () => {
  const status = financialDayStatus({ swapSource: 'finalized-block-ledger', swapRankingBasis: 'liquidity-fees-usd',
    pendingSwaps: 3, unpricedSwaps: 2, settlement: { status: 'pending', checkedAt: '2026-10-29T04:15:00Z',
      nextCheckAt: '2026-10-29T04:25:00Z' } });
  assert.match(status.warning, /3 swaps awaiting completion or verification/);
  assert.match(status.warning, /missing fee or price data/);
  assert.doesNotMatch(status.warning, /last seen pending|saved Midgard status|not automatically retried/);
  assert.match(status.settlement, /Saved swap candidates are checked after completion/);
  assert.match(status.settlement, /Latest candidate check/);
  assert.doesNotMatch(status.settlement, /Last complete pending-ID check/);
});

test('a paused swap scan keeps separate visible cutoffs for swaps and current pool rankings', () => {
  const timeZone = 'America/New_York';
  const swapThrough = '2026-10-29T07:45:00Z', poolThrough = '2026-10-29T21:30:00Z';
  const status = financialDayStatus({ through: swapThrough, deferred: true, progress: {phase:'actions'},
    poolRanking: {from:'2026-10-29T04:00:00Z',through:poolThrough,complete:true,stale:false,fallback:false} }, {timeZone});
  assert.equal(status.pauseLabel, 'Swap acquisition paused');
  assert.equal(status.swapThrough, `Through ${formatLocalDateTime(swapThrough,{timeZone})}`);
  assert.equal(status.poolThrough, `Through ${formatLocalDateTime(poolThrough,{timeZone})}`);
  assert.equal(status.poolWarning, '');
  assert.doesNotMatch(status.poolThrough, /03:45/);
});

test('pool fallback and incomplete coverage remain explicit without claiming no volume', () => {
  const status = financialDayStatus({poolRanking:{through:'2026-10-29T07:45:00Z',complete:false,
    fallback:true,stale:true,missingPools:['BTC.BTC','ETH.ETH']},pools:[]});
  assert.match(status.poolWarning, /saved ranking/i);
  assert.match(status.poolWarning, /delayed/i);
  assert.match(status.poolWarning, /2 pools.*unavailable/i);
  assert.match(status.poolEmpty, /unavailable/i);
  assert.doesNotMatch(status.poolEmpty, /No pool volume/);
});

test('missing pool coverage metadata never invents a current cutoff or zero-volume claim', () => {
  const unavailable = financialDayStatus({through:'2026-10-29T07:45:00Z',poolRanking:{complete:false,through:null},pools:[]});
  assert.equal(unavailable.poolThrough, 'Pool coverage unavailable');
  assert.match(unavailable.poolEmpty, /unavailable/i);
  const invalid = financialDayStatus({poolRanking:{complete:true,through:'bad'},pools:[]});
  assert.doesNotMatch(invalid.poolThrough, /Invalid Date|Through/);
  assert.match(invalid.poolEmpty, /unavailable/i);
  const zero = financialDayStatus({poolRanking:{complete:true,through:'2026-10-29T21:30:00Z'},pools:[]});
  assert.equal(zero.poolEmpty,'No pool volume in this window.');
});
