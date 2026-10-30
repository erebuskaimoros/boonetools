import assert from 'node:assert/strict';
import test from 'node:test';
import { repairFinancialReserveEmissions } from '../src/shared/financials-reserve-service.js';

const METHOD = 'historical-reserve-formula-v1';
const observation = (height, overrides = {}) => ({ schemaVersion: 1, height,
  reserveDeltaE8: '9995178', afterRewardsDeltaE8: '0', rewardTransfersE8: '282329907',
  rewardEventCount: 1, configChanges: [], ...overrides });
const row = (height, overrides) => ({ height: String(height), reserve_observation: observation(height, overrides) });
const anchor = (height) => ({ height, reserveBalanceE8: '2534440071363139', version: '3.20.3',
  emissionCurve: '100000', reserveMaxCapE8: '0', blocksPerYear: '5256000' });

function database(rows) {
  const writes = [];
  const failures = [];
  const reads = [];
  return { writes, failures, reads, failureWrites: 0,
    async query(sql, values) {
      if (/select height::text/.test(sql)) { reads.push(values); return { rows }; }
      if (/set reserve_emissions_e8/.test(sql)) {
        const incoming = JSON.parse(values[0]); writes.push(...incoming); return { rowCount: incoming.length };
      }
      if (/set emissions_evidence/.test(sql)) {
        this.failureWrites++;
        const incoming = JSON.parse(values[0]); failures.push(...incoming); return { rowCount: incoming.length };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('one verified anchor reconstructs a contiguous chunk and persists method plus evidence atomically', async () => {
  const db = database([row(28204118), row(28204117), row(28204116)]);
  const anchors = [];
  const result = await repairFinancialReserveEmissions(db, { fetchAnchor: async (height) => { anchors.push(height); return anchor(height); } });
  assert.deepEqual(anchors, [28204118]);
  assert.equal(result.reconstructed, 3);
  assert.equal(db.writes.length, 3);
  assert.equal(db.writes[0].reserve_emissions_e8, '4822');
  assert.equal(db.writes[0].emissions_method, METHOD);
  assert.equal(db.writes[0].emissions_evidence.anchor.height, 28204118);
  assert.equal(db.writes[0].emissions_evidence.reserve_before_rewards_e8, '2534440353693046');
});

test('the live tail waits to share one anchor while backlog and aged tails proceed', async () => {
  const nowMs = Date.parse('2026-10-30T03:00:00Z');
  const live = (height, ageMs) => ({ ...row(height), block_time_s: (nowMs - ageMs) / 1000 });
  const repair = async (rows) => {
    const anchors = [];
    const result = await repairFinancialReserveEmissions(database(rows), { now: () => nowMs,
      fetchAnchor: async (height) => { anchors.push(height); return anchor(height); } });
    return { anchors, result };
  };

  // Two fresh live blocks wait; the older backlog island still gets its anchor.
  const waiting = await repair([live(28204120, 6_000), live(28204119, 12_000), row(28204110), row(28204109)]);
  assert.deepEqual(waiting.anchors, [28204110]);
  assert.equal(waiting.result.waiting, 2);
  assert.equal(waiting.result.complete, true);

  // A tail that has waited long enough, or grown to a full batch, is anchored once.
  const aged = await repair([live(28204120, 6_000), live(28204119, 121_000)]);
  assert.deepEqual(aged.anchors, [28204120]);
  const full = await repair(Array.from({ length: 20 }, (_, index) => live(28204150 - index, 6_000)));
  assert.deepEqual(full.anchors, [28204150]);
  assert.equal(full.result.reconstructed, 20);
});

test('a repeated unsupported observation is deferred in one bounded database write', async () => {
  const db = database(Array.from({ length: 100 }, (_, offset) => row(28204118 - offset, { rewardEventCount: 0 })));
  const result = await repairFinancialReserveEmissions(db, { fetchAnchor: async () => { throw new Error('must not acquire'); } });
  assert.equal(result.deferred, 100);
  assert.equal(db.failureWrites, 1);
});

test('gaps are never extrapolated across: each disjoint chunk obtains its own verified anchor', async () => {
  const db = database([row(28204118), row(28204117), row(28204115)]);
  const anchors = [];
  await repairFinancialReserveEmissions(db, { fetchAnchor: async (height) => { anchors.push(height); return anchor(height); } });
  assert.deepEqual(anchors, [28204118, 28204115]);
  assert.equal(db.writes.length, 3);
});

test('a malformed observation or config transition is deferred without starving older valid chunks', async () => {
  const db = database([row(28204118), row(28204117, { configChanges: [{ type: 'version', version: '3.20.3' }] }),
    row(28204116), row(28204115, { reserveDeltaE8: 'bad' }), row(28204114)]);
  const anchors = [];
  const result = await repairFinancialReserveEmissions(db, { fetchAnchor: async (height) => { anchors.push(height); return anchor(height); } });
  assert.deepEqual(anchors, [28204118, 28204116, 28204114]);
  assert.equal(result.reconstructed, 3);
  assert.deepEqual(db.failures.map((item) => item.height), [28204117, 28204115]);
  assert.ok(db.failures.every((item) => item.emissions_evidence.retry_after));
});

test('the reviewed 3.21.0 upgrade block is reconstructed inside one verified chunk', async () => {
  // Production observations around the 3.20.3 -> 3.21.0 upgrade at 28366100.
  const db = database([
    row(28366101, { reserveDeltaE8: '25995328', rewardTransfersE8: '386376606' }),
    row(28366100, { reserveDeltaE8: '-79694928482546', rewardTransfersE8: '3841376895',
      configChanges: [{ type: 'version', version: '3.21.0' }] }),
    row(28366099, { reserveDeltaE8: '1995175', rewardTransfersE8: '5086087' })
  ]);
  const anchors = [];
  const result = await repairFinancialReserveEmissions(db, { fetchAnchor: async (height) => {
    anchors.push(height);
    return { ...anchor(height), reserveBalanceE8: '2456239632252315', version: '3.21.0' };
  } });
  assert.deepEqual(anchors, [28366101]);
  assert.equal(result.deferred, 0);
  assert.equal(result.reconstructed, 3);
  assert.deepEqual(db.failures, []);
  assert.deepEqual(db.writes.map((item) => [item.height, item.reserve_emissions_e8]),
    [[28366101, '4673'], [28366100, '4673'], [28366099, '4825']]);
});

test('unsupported anchored versions fail closed and are deferred while an older supported chunk can complete', async () => {
  const db = database([row(28204118), row(28204116)]);
  const result = await repairFinancialReserveEmissions(db, { fetchAnchor: async (height) => ({ ...anchor(height),
    version: height === 28204118 ? '3.22.0' : '3.20.3' }) });
  assert.equal(result.reconstructed, 1);
  assert.equal(db.writes[0].height, 28204116);
  assert.equal(db.failures[0].height, 28204118);
  assert.match(db.failures[0].emissions_evidence.error, /Unsupported/);
});

test('ordinary provider failure preserves previous chunks and is not mislabeled as bad block evidence', async () => {
  const db = database([row(28204118), row(28204116)]);
  await assert.rejects(repairFinancialReserveEmissions(db, { fetchAnchor: async (height) => {
    if (height === 28204116) throw new Error('provider cooling down');
    return anchor(height);
  } }), /cooling down/);
  assert.equal(db.writes.length, 1);
  assert.equal(db.failures.length, 0);
});

test('a deferred backlog is not starved by the newest live blocks when anchors exhaust the budget', async () => {
  // After the 3.21.0 deferral, every pass's newest-first chunk was a few dozen
  // fresh blocks; one slow anchor spent the budget and the backlog never ran.
  const live = [28411700, 28411699].map((height) => row(height));
  const backlog = Array.from({ length: 6 }, (_, offset) => row(28400000 - offset));
  const db = database([...live, ...backlog]);
  let clock = 0;
  const anchors = [];
  const result = await repairFinancialReserveEmissions(db, { now: () => clock, budgetMs: 20_000,
    fetchAnchor: async (height) => { anchors.push(height); clock += 30_000; return anchor(height); } });
  assert.deepEqual(anchors, [28400000], 'the largest contiguous chunk is anchored first');
  assert.equal(result.reconstructed, 6);
  assert.deepEqual(db.writes.map((item) => item.height), backlog.map((item) => Number(item.height)));
});

test('cancellation and chunk budgets bound anchor work, and explicit date filters reach the query', async () => {
  const db = database([row(28204118), row(28204116)]);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const canceled = await repairFinancialReserveEmissions(db, { signal: controller.signal,
    fetchAnchor: async (height) => { calls++; return anchor(height); } });
  assert.equal(calls, 0);
  assert.equal(canceled.reconstructed, 0);
  const limited = await repairFinancialReserveEmissions(db, { maxChunks: 1, from: 1791331200,
    fetchAnchor: async (height) => { calls++; return anchor(height); } });
  assert.equal(limited.reconstructed, 1);
  assert.equal(calls, 1);
  assert.equal(db.reads.at(-1)[1], 1791331200);
});
