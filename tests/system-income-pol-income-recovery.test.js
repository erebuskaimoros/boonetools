import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySystemIncomePolHead,
  normalizeSystemIncomePolPayload,
  reconcileSystemIncomePolSnapshot
} from '../src/lib/system-income-pol/model.js';

function completeSnapshot() {
  return {
    summary: {
      total_system_income_e8: '1000000000000',
      total_funded_e8: '200000000000',
      total_rune_held_e8: '90000000000',
      total_deployed_e8: '180000000000',
      rune_held_system_income_share_bps: 900,
      system_income_pol_share_bps: 2000,
      pol_reserve_system_income_bps: 2000
    },
    live: { through_height: 100, through_time: '2026-09-24T12:00:00Z' },
    daily: [{ day: '2026-09-24', system_income_e8: '1000000000000' }]
  };
}

test('an incomplete live head retains the last confirmed income share and marks it pending', () => {
  const baseline = completeSnapshot();
  const next = applySystemIncomePolHead(baseline, {
    height: 101, time: '2026-09-24T12:00:06Z', system_income_e8: null
  });
  const summary = normalizeSystemIncomePolPayload(next).summary;
  assert.equal(summary.runeHeldSystemIncomeSharePercent, 9);
  assert.equal(summary.systemIncomePolSharePercent, 20);
  assert.equal(summary.systemIncomeSharePending, true);
  assert.equal(summary.totalSystemIncomeE8, null, 'Missing income is not fabricated as zero');
  assert.equal(summary.polReserveSystemIncomePercent, 20);
  assert.equal(baseline.summary.total_system_income_e8, '1000000000000');
});

test('later complete heads cannot turn an incomplete denominator into a fresh percentage', () => {
  let next = applySystemIncomePolHead(completeSnapshot(), {
    height: 101, time: '2026-09-24T12:00:06Z'
  });
  next = applySystemIncomePolHead(next, {
    height: 102, time: '2026-09-24T12:00:12Z', system_income_e8: '100000000'
  });
  const summary = normalizeSystemIncomePolPayload(next).summary;
  assert.equal(summary.runeHeldSystemIncomeSharePercent, 9);
  assert.equal(summary.systemIncomeSharePending, true);
  assert.equal(summary.totalSystemIncomeE8, null);
});

test('a skipped block does not silently undercount the income denominator', () => {
  const next = applySystemIncomePolHead(completeSnapshot(), {
    height: 102, time: '2026-09-24T12:00:12Z', system_income_e8: '100000000'
  });
  const summary = normalizeSystemIncomePolPayload(next).summary;
  assert.equal(summary.totalSystemIncomeE8, null);
  assert.equal(summary.runeHeldSystemIncomeSharePercent, 9);
  assert.equal(summary.systemIncomeSharePending, true);
  assert.equal(next.daily[0].system_income_e8, null);
});

function replay(snapshot, heads, previous) {
  const byHeight = new Map(heads.map(head => [head.height, head]));
  const replayed = [...byHeight.values()].sort((left, right) => left.height - right.height)
    .reduce(applySystemIncomePolHead, snapshot);
  return reconcileSystemIncomePolSnapshot(replayed, previous);
}

test('corrected same-height heads replay from the snapshot and recover without double-counting', () => {
  const baseline = completeSnapshot();
  const original = structuredClone(baseline);
  const incomplete = { height: 101, time: '2026-09-24T12:00:06Z', pol_reserve_reward_e8: '20000000' };
  const following = { height: 102, time: '2026-09-24T12:00:12Z', system_income_e8: '200000000', pol_reserve_reward_e8: '40000000' };
  const pending = replay(baseline, [incomplete, following], baseline);
  const correction = { ...incomplete, system_income_e8: '100000000' };
  const recovered = replay(baseline, [incomplete, following, correction], pending);

  assert.equal(pending.summary.system_income_share_pending, true);
  assert.equal(recovered.summary.system_income_share_pending, false);
  assert.equal(recovered.summary.total_system_income_e8, '1000300000000');
  assert.equal(recovered.summary.total_funded_e8, '200060000000');
  assert.equal(recovered.summary.rune_held_system_income_share_bps, 899.73);
  assert.equal(recovered.summary.system_income_pol_share_bps, 2000);
  assert.equal(recovered.daily[0].system_income_e8, '1000300000000');
  assert.deepEqual(replay(baseline, [correction, following, correction, following], recovered), recovered);
  assert.equal(applySystemIncomePolHead(recovered, following), recovered);
  assert.deepEqual(baseline, original);
});

test('out-of-order missing heights recover once contiguous replay is possible', () => {
  const baseline = completeSnapshot();
  const later = { height: 102, time: '2026-09-24T12:00:12Z', system_income_e8: '200000000' };
  const earlier = { height: 101, time: '2026-09-24T12:00:06Z', system_income_e8: '100000000' };
  const pending = replay(baseline, [later], baseline);
  const recovered = replay(baseline, [later, earlier], pending);
  assert.equal(pending.summary.system_income_share_pending, true);
  assert.equal(recovered.summary.system_income_share_pending, false);
  assert.equal(recovered.summary.total_system_income_e8, '1000300000000');
});

test('incomplete snapshots preserve only prior percentage display fields, not stale source data', () => {
  const previous = completeSnapshot();
  previous.summary.total_estimated_fees_e8 = '123';
  previous.pools = [{ asset: 'BTC.BTC', units_e8: '1234' }];
  const snapshot = {
    summary: {
      total_system_income_e8: null,
      rune_held_system_income_share_bps: null,
      system_income_pol_share_bps: null,
      total_rune_held_e8: '95000000000',
      total_estimated_fees_e8: null,
      total_funded_e8: '202000000000',
      pol_reserve_system_income_bps: 2500
    },
    pools: [{ asset: 'XRP.XRP', units_e8: '900' }],
    live: { through_height: 110 },
    warnings: ['income pending']
  };
  const original = structuredClone(snapshot);
  const next = reconcileSystemIncomePolSnapshot(snapshot, previous);
  assert.deepEqual(next, {
    ...snapshot,
    summary: {
      ...snapshot.summary,
      rune_held_system_income_share_bps: 900,
      system_income_pol_share_bps: 2000,
      system_income_share_pending: true
    }
  });
  assert.deepEqual(snapshot, original);
  assert.equal(normalizeSystemIncomePolPayload(next).summary.runeHeldSystemIncomeSharePercent, 9);

  const pendingAgain = reconcileSystemIncomePolSnapshot(snapshot, next);
  assert.equal(pendingAgain.summary.rune_held_system_income_share_bps, 900);
  assert.equal(pendingAgain.summary.total_system_income_e8, null);
});

test('complete authoritative snapshots replace pending percentages and clear the pending state', () => {
  const pending = applySystemIncomePolHead(completeSnapshot(), { height: 101 });
  const fresh = completeSnapshot();
  fresh.summary.total_system_income_e8 = '1100000000000';
  fresh.summary.total_rune_held_e8 = '100000000000';
  fresh.summary.rune_held_system_income_share_bps = 909.09;
  fresh.summary.system_income_pol_share_bps = 1818.18;
  fresh.live.through_height = 110;
  const next = reconcileSystemIncomePolSnapshot(fresh, pending);
  assert.equal(next.summary.system_income_share_pending, false);
  assert.equal(next.summary.total_system_income_e8, '1100000000000');
  assert.equal(next.summary.rune_held_system_income_share_bps, 909.09);
  assert.equal(next.summary.system_income_pol_share_bps, 1818.18);
});

test('first-load unknown income remains unknown and cannot inherit an invented percentage', () => {
  const initial = reconcileSystemIncomePolSnapshot({ summary: { total_system_income_e8: null }, live: { through_height: 100 } });
  const next = applySystemIncomePolHead(initial, { height: 101, system_income_e8: '100000000' });
  const summary = normalizeSystemIncomePolPayload(next).summary;
  assert.equal(summary.totalSystemIncomeE8, null);
  assert.equal(summary.systemIncomePolSharePercent, null);
  assert.equal(summary.runeHeldSystemIncomeSharePercent, null);
  assert.equal(summary.systemIncomeSharePending, true);
});

test('zero income is a complete live observation, not a missing denominator contribution', () => {
  const next = applySystemIncomePolHead(completeSnapshot(), { height: 101, system_income_e8: '0' });
  assert.equal(next.summary.total_system_income_e8, '1000000000000');
  assert.equal(next.summary.system_income_share_pending, false);
  assert.equal(next.summary.rune_held_system_income_share_bps, 900);
  assert.equal(next.summary.system_income_pol_share_bps, 2000);
});

test('invalid live income cannot fabricate a cumulative total and pending fields survive normalization', () => {
  for (const income of [undefined, null, '', 'invalid']) {
    const next = applySystemIncomePolHead(completeSnapshot(), { height: 101, system_income_e8: income });
    const summary = normalizeSystemIncomePolPayload(next).summary;
    assert.equal(summary.totalSystemIncomeE8, null);
    assert.equal(summary.systemIncomeSharePending, true);
    assert.equal(summary.runeHeldSystemIncomeSharePercent, 9);
  }
  assert.equal(normalizeSystemIncomePolPayload(completeSnapshot()).summary.systemIncomeSharePending, false);
});
