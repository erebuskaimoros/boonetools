import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  acceptSystemIncomePolSnapshot,
  bufferSystemIncomePolHead,
  mergeSystemIncomePolHeads,
  replaySystemIncomePolHeads
} from '../src/lib/system-income-pol/live.js';
import { normalizeSystemIncomePolPayload } from '../src/lib/system-income-pol/model.js';

const baseline = {
  summary: {
    total_system_income_e8: '1000', total_funded_e8: '200',
    total_rune_held_e8: '90', total_deployed_e8: '150',
    rune_held_system_income_share_bps: 900, system_income_pol_share_bps: 2000
  },
  live: { through_height: 100 },
  daily: [{ day: '2026-09-24', system_income_e8: '1000', funded_e8: '200', deployed_e8: '150' }]
};
const completeHead = height => ({
  height, time: '2026-09-24T12:00:00Z', system_income_e8: '100',
  pol_reserve_reward_e8: '20', pol_reserve_deployments: [{ asset: 'BTC.BTC', rune_e8: '10' }]
});

test('a same-height correction recovers the income share without double-counting any flows', () => {
  let heads = mergeSystemIncomePolHeads([], { ...completeHead(101), system_income_e8: null });
  let display = replaySystemIncomePolHeads(baseline, heads);
  assert.equal(normalizeSystemIncomePolPayload(display).summary.runeHeldSystemIncomeSharePercent, 9);
  heads = mergeSystemIncomePolHeads(heads, completeHead(102));
  display = replaySystemIncomePolHeads(baseline, heads, display);
  assert.equal(display.summary.system_income_share_pending, true);
  heads = mergeSystemIncomePolHeads(heads, completeHead(101));
  display = replaySystemIncomePolHeads(baseline, heads, display);
  assert.equal(display.summary.total_system_income_e8, '1200');
  assert.equal(display.summary.rune_held_system_income_share_bps, 750);
  assert.equal(display.summary.system_income_share_pending, false);
  assert.equal(display.summary.total_funded_e8, '240');
  assert.equal(display.summary.total_deployed_e8, '170');
  assert.equal(display.daily[0].system_income_e8, '1200');
  const repeated = replaySystemIncomePolHeads(baseline, mergeSystemIncomePolHeads(heads, completeHead(101)), display);
  assert.deepEqual(repeated, display);
  assert.equal(baseline.summary.total_system_income_e8, '1000');
});

test('an out-of-order head closes an income gap and a header-only duplicate cannot reopen it', () => {
  let heads = mergeSystemIncomePolHeads([], completeHead(102));
  const pending = replaySystemIncomePolHeads(baseline, heads);
  assert.equal(pending.summary.system_income_share_pending, true);
  heads = mergeSystemIncomePolHeads(heads, completeHead(101));
  const recovered = replaySystemIncomePolHeads(baseline, heads, pending);
  assert.equal(recovered.summary.total_system_income_e8, '1200');
  assert.equal(recovered.summary.system_income_share_pending, false);
  const unchangedHeads = mergeSystemIncomePolHeads(heads, { height: 101, system_income_e8: null });
  assert.equal(unchangedHeads, heads);
});

test('a complete newer snapshot clears pending and supersedes buffered heads', () => {
  const heads = mergeSystemIncomePolHeads([], { ...completeHead(101), system_income_e8: null });
  const pending = replaySystemIncomePolHeads(baseline, heads);
  const refreshed = {
    ...baseline, live: { through_height: 103 },
    summary: { ...baseline.summary, total_system_income_e8: '1300', rune_held_system_income_share_bps: 692.30 }
  };
  const result = replaySystemIncomePolHeads(refreshed, heads, pending);
  assert.equal(result.summary.total_system_income_e8, '1300');
  assert.equal(result.summary.rune_held_system_income_share_bps, 692.30);
  assert.equal(result.summary.system_income_share_pending, false);
});

test('compacting an observed gap retains pending income until an authoritative refresh', () => {
  let buffered = { snapshot: baseline, recentHeads: [] };
  for (let height = 102; height <= 615; height += 1) {
    buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, completeHead(height));
  }
  assert.equal(buffered.recentHeads.length, 512);
  assert.equal(buffered.snapshot.live.through_height, 103);
  const result = replaySystemIncomePolHeads(buffered.snapshot, buffered.recentHeads);
  assert.equal(result.summary.total_system_income_e8, null);
  assert.equal(result.summary.system_income_share_pending, true);

  const late = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, completeHead(101));
  assert.equal(late.snapshot, buffered.snapshot);
  assert.deepEqual(late.recentHeads, buffered.recentHeads);
  const refreshed = {
    ...baseline, live: { through_height: 615 },
    summary: { ...baseline.summary, total_system_income_e8: '52500', rune_held_system_income_share_bps: 17.14 }
  };
  const snapshot = acceptSystemIncomePolSnapshot(buffered.snapshot, refreshed);
  const recovered = replaySystemIncomePolHeads(snapshot, buffered.recentHeads, result);
  assert.equal(recovered.summary.system_income_share_pending, false);
  assert.equal(recovered.summary.total_system_income_e8, '52500');
});

test('a prolonged snapshot outage cannot erase already observed deposits', () => {
  let buffered = { snapshot: baseline, recentHeads: [] };
  let display = baseline;
  for (let height = 101; height <= 613; height += 1) {
    const head = completeHead(height);
    if (height === 101) head.pol_reserve_deployments[0].rune_e8 = '1000';
    buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, head);
    display = replaySystemIncomePolHeads(buffered.snapshot, buffered.recentHeads, display);
    assert.ok(buffered.recentHeads.length <= 512);
  }
  assert.equal(display.summary.total_deployed_e8, '6270');
  assert.equal(display.summary.total_funded_e8, '10460');
  assert.equal(display.summary.total_system_income_e8, '52300');
  assert.equal(display.summary.system_income_share_pending, false);
  assert.equal(display.daily[0].deployed_e8, '6270');
  assert.equal(buffered.snapshot.live.through_height, 101);
  assert.equal(baseline.live.through_height, 100);
  assert.equal(baseline.summary.total_deployed_e8, '150');
});

test('a same-height correction just before eviction is compacted exactly once', () => {
  let buffered = { snapshot: baseline, recentHeads: [] };
  for (let height = 101; height <= 612; height += 1) {
    const head = completeHead(height);
    if (height === 101) head.system_income_e8 = null;
    buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, head);
  }
  assert.equal(replaySystemIncomePolHeads(buffered.snapshot, buffered.recentHeads).summary.system_income_share_pending, true);
  const corrected = completeHead(101);
  corrected.pol_reserve_deployments[0].rune_e8 = '1000';
  buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, corrected);
  buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, completeHead(613));
  let display = replaySystemIncomePolHeads(buffered.snapshot, buffered.recentHeads);
  assert.equal(display.summary.system_income_share_pending, false);
  assert.equal(display.summary.total_deployed_e8, '6270');
  assert.equal(display.summary.total_system_income_e8, '52300');

  buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, corrected);
  const duplicate = replaySystemIncomePolHeads(buffered.snapshot, buffered.recentHeads, display);
  assert.deepEqual(duplicate, display);
  assert.equal(buffered.recentHeads.length, 512);
});

test('delayed snapshots cannot rewind compacted totals; same-height authoritative snapshots may recover income', () => {
  let buffered = { snapshot: baseline, recentHeads: [] };
  for (let height = 101; height <= 613; height += 1) {
    const head = completeHead(height);
    if (height === 101) head.system_income_e8 = null;
    buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, head);
  }
  const compacted = buffered.snapshot;
  assert.equal(compacted.live.through_height, 101);
  assert.equal(compacted.summary.total_system_income_e8, null);
  assert.equal(acceptSystemIncomePolSnapshot(compacted, baseline), compacted);

  const refreshed = {
    ...baseline, live: { through_height: 101 },
    summary: {
      ...baseline.summary, total_system_income_e8: '1100', total_funded_e8: '220', total_deployed_e8: '160',
      total_rune_held_e8: '99', rune_held_system_income_share_bps: 900
    },
    daily: [{ day: '2026-09-24', system_income_e8: '1100', funded_e8: '220', deployed_e8: '160' }]
  };
  const accepted = acceptSystemIncomePolSnapshot(compacted, refreshed);
  assert.equal(accepted, refreshed);
  const recovered = replaySystemIncomePolHeads(accepted, buffered.recentHeads);
  assert.equal(recovered.summary.total_system_income_e8, '52300');
  assert.equal(recovered.summary.total_deployed_e8, '5280');
  assert.equal(recovered.summary.total_rune_held_e8, '99');
  assert.equal(recovered.summary.system_income_share_pending, false);
});

test('preload buffering remains bounded and a later first snapshot does not invent discarded income', () => {
  let buffered = { snapshot: null, recentHeads: [] };
  for (let height = 101; height <= 613; height += 1) {
    buffered = bufferSystemIncomePolHead(buffered.snapshot, buffered.recentHeads, completeHead(height));
  }
  assert.equal(buffered.snapshot, null);
  assert.equal(buffered.recentHeads.length, 512);
  const accepted = acceptSystemIncomePolSnapshot(buffered.snapshot, baseline);
  const initial = replaySystemIncomePolHeads(accepted, buffered.recentHeads);
  assert.equal(initial.summary.system_income_share_pending, true);
  assert.equal(initial.summary.total_system_income_e8, null);
});

test('the dashboard replays corrections and labels retained percentages as syncing', async () => {
  const source = await readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8');
  assert.match(source, /await fetchSystemIncomePol/);
  assert.match(source, /acceptSystemIncomePolSnapshot\(snapshotPayload, nextSnapshot\)/);
  assert.match(source, /replaySystemIncomePolHeads\(snapshotPayload, recentHeads, payload\)/);
  assert.match(source, /bufferSystemIncomePolHead\(snapshotPayload, recentHeads, head\)/);
  assert.match(source, /OF INCOME · SYNCING/);
  assert.match(source, /Last confirmed percentage/);
});
