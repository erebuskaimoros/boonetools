import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNearNetSupply, nearNetSupplyDays, verifyNearSupplyBoundary } from '../src/protocol-fee-comparison/near-net-supply.js';

const date = '2026-09-01', end = '2026-09-02';
const ns = day => BigInt(Date.parse(day)) * 1_000_000n;
const base = 1300000000000000000000000000000000n;
function pair(day, height, supply) {
  return [{ hash: `h${height}`, height, total_supply: supply.toString(), timestamp_nanosec: (ns(day) - 1n).toString() },
    { hash: `h${height + 2}`, height: height + 2, prev_height: height, prev_hash: `h${height}`,
      total_supply: (supply + 123n).toString(), timestamp_nanosec: ns(day).toString() }];
}
function fixture(delta = 9007199254740993n) {
  const pairs = { [date]: pair(date, 10, base), [end]: pair(end, 100, base + delta) };
  const calls = [];
  const request = async (url, { body } = {}) => {
    calls.push({ url, body });
    if (url.includes('nearblocks')) {
      const cursor = JSON.parse(Buffer.from(new URL(url).searchParams.get('prev'), 'base64').toString());
      const day = new Date(Number((BigInt(cursor.timestamp) + 1n) / 1_000_000n)).toISOString().slice(0, 10);
      const after = pairs[day][1];
      return { data: [{ block_height: String(after.height), block_hash: after.hash }] };
    }
    if (body.params.finality) return { result: { header: { height: 1000, hash: 'final', total_supply: base.toString(), timestamp_nanosec: (ns(end) + 1000n).toString() } } };
    const h = Object.values(pairs).flat().find(h => h.height === body.params.block_id || h.hash === body.params.block_id);
    return { result: { header: h } };
  };
  return { pairs, calls, request };
}

test('net supply uses linked archive headers, skipped heights and exact UTC midnight semantics', async () => {
  const f = fixture(), boundaries = {}, saved = [];
  const rows = await collectNearNetSupply({ ...f, boundaries, startDay: date, endDay: end, save: async () => saved.push(structuredClone(boundaries)) });
  assert.equal(rows[0].nearNetIssuanceAtomic, '9007199254740993');
  assert.equal(f.calls.length, 7, 'one final head plus index hint and two archive calls per boundary');
  assert.equal(saved.length, 2);
  f.calls.length = 0;
  assert.deepEqual(await collectNearNetSupply({ ...f, boundaries, startDay: date, endDay: end }), rows);
  assert.equal(f.calls.length, 1, 'immutable proofs are reused');
});

test('negative net issuance and exact zero survive; missing boundary never becomes zero', async () => {
  for (const delta of [-9007199254740993n, 0n]) {
    const rows = await collectNearNetSupply({ ...fixture(delta), startDay: date, endDay: end });
    assert.equal(rows[0].nearNetIssuanceAtomic, delta.toString());
  }
  assert.throws(() => nearNetSupplyDays({}, date, end), /Missing/);
});

test('wrong date, broken parent links and malformed supplies fail closed', () => {
  const [before, after] = pair(date, 10, base);
  for (const patch of [{ prev_hash: 'wrong' }, { prev_height: 9 }, { timestamp_nanosec: (ns(date) - 1n).toString() }, { total_supply: '-1' }]) {
    assert.throws(() => verifyNearSupplyBoundary(date, before, { ...after, ...patch }), /Unverified/);
  }
  assert.throws(() => verifyNearSupplyBoundary(date, { ...before, timestamp_nanosec: ns(date).toString() }, after), /Unverified/);
});

test('bad index hints and unfinalized archive data are rejected before checkpointing', async () => {
  for (const kind of ['hash', 'height', 'lag']) {
    const f = fixture(), boundaries = {};
    await assert.rejects(collectNearNetSupply({ startDay: date, endDay: end, boundaries, request: async (url, options) => {
      const result = await f.request(url, options);
      if (url.includes('nearblocks')) {
        if (kind === 'hash') result.data[0].block_hash = 'wrong';
        if (kind === 'height') result.data[0].block_height = '1001';
      }
      if (kind === 'lag' && options?.body.params.finality) result.result.header.timestamp_nanosec = (ns(end) - 1n).toString();
      return result;
    } }), /mismatch|unfinalized|behind/);
    assert.deepEqual(boundaries, {});
  }
});

test('interrupted acquisition resumes verified boundaries without publishing partial daily history', async () => {
  const f = fixture(), boundaries = {};
  await assert.rejects(collectNearNetSupply({ ...f, boundaries, startDay: date, endDay: end, save: async () => { throw new Error('interrupted'); } }), /interrupted/);
  assert.deepEqual(Object.keys(boundaries), [end]);
  f.calls.length = 0;
  const rows = await collectNearNetSupply({ ...f, boundaries, startDay: date, endDay: end });
  assert.equal(rows.length, 1);
  assert.equal(f.calls.length, 4);
});
