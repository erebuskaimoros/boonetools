import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceFinancialDay, financialDayStateFromSnapshot, refreshFinancialDayQueue, readFinancialDay,
  financialDayNeedsWork } from '../src/shared/financials-day-detail.js';

const day = '2026-10-23';
const now = Date.parse('2026-10-24T02:00:00Z');
const from = Date.parse(`${day}T00:00:00Z`) / 1000;
const pools = [{ asset: 'BTC.BTC', volumeUsd: 12345, volumeRune: 6789 }];
const snapshot = (ids = ['PENDING-A']) => ({ day, through: '2026-10-24T00:00:00.000Z',
  observedAt: '2026-10-24T00:22:00.000Z', partial: false, finalized: false,
  pendingSwaps: ids.length, unpricedSwaps: 0, exclusionsIncomplete: false,
  runePrices: [{ from, to: from + 86400, price: 1 }], excludedSwaps: ids.map(txId => ({ txId, kind: 'pending' })), swaps: [], pools });
const action = (txId, status = 'success') => ({ type: 'swap', status,
  date: String(BigInt(from + 100) * 1000000000n),
  in: [{ txID: txId, coins: [{ asset: 'BTC.BTC', amount: '200000000' }] }],
  out: [{ coins: [{ asset: 'ETH.ETH', amount: '400000000' }] }],
  metadata: { swap: { inPriceUSD: '60000', liquidityFee: '12000000000000', isStreamingSwap: true } } });

test('closed roster reconciles the retained transaction ID without reacquiring the day or pools', async () => {
  const routes = [];
  const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async route => {
    routes.push(route);
    const url = new URL(route, 'https://example.invalid');
    assert.equal(url.pathname, '/actions');
    assert.equal(url.searchParams.get('txid'), 'PENDING-A');
    assert.equal(url.searchParams.has('timestamp'), false);
    assert.equal(url.searchParams.has('nextPageToken'), false);
    return { actions: [action('PENDING-A')] };
  }, now);
  assert.equal(routes.length, 1, 'must look up the retained ID instead of freezing its stale pending status');
  assert.equal(result.payload.pendingSwaps, 0);
  assert.equal(result.payload.swaps[0].volumeUsd, 120000);
  assert.deepEqual(result.payload.excludedSwaps, []);
  assert.deepEqual(result.payload.pools, pools, 'executed pool totals must stay cached');
  assert.equal(result.payload.through, snapshot().through);
});

test('targeted rechecks cannot resolve an exclusion from another transaction in the response', async () => {
  let requests = 0;
  const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => {
    requests++;
    return { actions: [action('UNRELATED')] };
  }, now);
  assert.equal(requests, 1);
  assert.equal(result.payload.pendingSwaps, 1);
  assert.equal(result.payload.swaps.length, 0);
  assert.deepEqual(result.payload.excludedSwaps, snapshot().excludedSwaps);
});

test('a settlement pass checkpoints each ID so a restart never repeats the first pending ID', async () => {
  const requests = [];
  const source = async route => {
    const id = new URL(route, 'https://example.invalid').searchParams.get('txid');
    requests.push(id);
    return { actions: [action(id, id === 'PENDING-A' ? 'pending' : 'success')] };
  };
  const first = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(['PENDING-A', 'PENDING-B']), now), source, now);
  const second = await advanceFinancialDay(day, JSON.parse(JSON.stringify(first.state)), source, now + 1000);
  assert.deepEqual(requests, ['PENDING-A', 'PENDING-B']);
  assert.equal(second.payload.pendingSwaps, 1);
  assert.equal(second.payload.swaps[0].txId, 'PENDING-B');
  assert.deepEqual(second.payload.pools, pools);
  await advanceFinancialDay(day, second.state, source, now + 2000);
  assert.equal(requests.length, 2, 'still-pending IDs need a scheduled backoff, not an immediate second pass');
});

test('legacy count-only exclusions remain provisional without a full-day rescan', async () => {
  const legacy = { ...snapshot(), excludedSwaps: undefined };
  const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, legacy, now), async () => {
    assert.fail('no retained transaction IDs means no targeted request is possible');
  }, now);
  assert.equal(result.payload.pendingSwaps, 1);
  assert.equal(result.payload.finalized, false);
});

test('background queue adopts saved closed pending IDs under its existing request cap', async () => {
  const queries = [], routes = [];
  const client = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('select')) return { rows: [{ day, state_json: null, payload_json: snapshot(),
      background: true, requested_at: new Date(now - 3600_000).toISOString() }] };
    return { rows: [] };
  } };
  await refreshFinancialDayQueue(client, { now: () => now, maxRequests: 1, getJson: async route => {
    routes.push(route); return { actions: [action('PENDING-A')] };
  } });
  assert.equal(routes.length, 1, 'closed-day pending reconciliation must be eligible without a viewer');
  assert.match(routes[0], /[?&]txid=PENDING-A(?:&|$)/);
  const saved = queries.find(query => query.sql.startsWith('update') && query.sql.includes('state_json'));
  assert.ok(saved, 'resolved ranking and cursor are persisted together');
  assert.equal(JSON.parse(saved.params[2]).pendingSwaps, 0);
});

test('only the canonical inbound identity can settle a saved exclusion', async () => {
  const unrelated = action('UNRELATED');
  unrelated.in.push(...action('PENDING-A').in);
  const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => ({ actions: [unrelated] }), now);
  assert.equal(result.payload.pendingSwaps, 1);
  assert.deepEqual(result.payload.swaps, []);
});

test('settled swaps are reranked with exact original UTC bounds and updated source action dates', async () => {
  const original = { ...snapshot(), swaps: Array.from({ length: 10 }, (_, index) => ({ txId: `OLD-${index}`, volumeUsd: 1000 - index, feeUsd: 1000 - index })) };
  for (const [seconds, included] of [[from, true], [from + 86399, true], [from - 1, false], [from + 86400, false]]) {
    const settled = { ...action('pending-a'), date: String(BigInt(seconds) * 1000000000n) };
    const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, original, now), async () => ({ actions: [settled] }), now);
    assert.equal(result.payload.pendingSwaps, 0);
    assert.equal(result.payload.swaps.length, 10);
    assert.equal(result.payload.swaps.some(row => row.txId === 'PENDING-A'), included);
    assert.deepEqual(result.payload.pools, pools);
    assert.deepEqual(original.swaps.length, 10, 'input snapshots are not mutated');
  }
});

test('successful refunds resolve exclusions without ranking, but pending refunds do not', async () => {
  for (const status of ['pending', 'success']) {
    const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => ({
      actions: [{ ...action('PENDING-A', status), type: 'refund' }]
    }), now);
    assert.equal(result.payload.pendingSwaps, status === 'success' ? 0 : 1);
    assert.equal(result.payload.swaps.length, 0);
  }
});

test('a successful refund cannot resolve a competing pending swap, while successful swap evidence wins', async () => {
  const pending = action('PENDING-A', 'pending');
  const refund = { ...action('PENDING-A'), type: 'refund' };
  const ambiguous = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => ({ actions: [pending, refund] }), now);
  assert.equal(ambiguous.payload.pendingSwaps, 1, 'a partial streaming refund must not imply the swap has settled');
  assert.deepEqual(ambiguous.payload.swaps, []);
  const settled = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => ({ actions: [pending, refund, action('PENDING-A')] }), now);
  assert.equal(settled.payload.pendingSwaps, 0);
  assert.equal(settled.payload.swaps[0].txId, 'PENDING-A');
});

test('settled but unpriced swaps change the exclusion kind, not the amount or pool totals', async () => {
  const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => ({
    actions: [{ ...action('PENDING-A'), metadata: {} }]
  }), now);
  assert.equal(result.payload.pendingSwaps, 0);
  assert.equal(result.payload.unpricedSwaps, 1);
  assert.deepEqual(result.payload.excludedSwaps, [{ txId: 'PENDING-A', kind: 'unpriced' }]);
  assert.deepEqual(result.payload.pools, pools);
  assert.equal(result.payload.settlement.status, 'complete');
  assert.equal(result.payload.finalized, false);
});

test('a refund does not hide a matching successful swap with an unusable source date', async () => {
  const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => ({
    actions: [{ ...action('PENDING-A'), date: 'invalid' }, { ...action('PENDING-A'), type: 'refund' }]
  }), now);
  assert.equal(result.payload.pendingSwaps, 1);
  assert.equal(result.payload.settlement.status, 'pending');
  assert.deepEqual(result.payload.swaps, []);
});

test('malformed lookup envelopes preserve the checkpoint; empty or invalid actions remain pending', async () => {
  const state = financialDayStateFromSnapshot(day, snapshot(), now);
  const saved = structuredClone(state);
  for (const response of [null, {}, { actions: null }, { actions: {} }]) {
    await assert.rejects(advanceFinancialDay(day, state, async () => response, now), /Invalid pending swap lookup/);
    assert.deepEqual(state, saved);
  }
  for (const actions of [[], [null], [{ ...action('PENDING-A'), date: 'not-a-date' }],
    [{ ...action('PENDING-A'), date: '9'.repeat(400) }], [action('PENDING-A', 'pending')]]) {
    const result = await advanceFinancialDay(day, state, async () => ({ actions }), now);
    assert.equal(result.payload.pendingSwaps, 1);
    assert.equal(result.payload.settlement.checkedAt, new Date(now).toISOString());
    assert.equal(Date.parse(result.payload.settlement.nextCheckAt), now + 3600_000);
  }
});

test('whole settlement passes back off for one, six, then at most twenty-four hours across restarts', async () => {
  let state = financialDayStateFromSnapshot(day, snapshot(), now), clock = now, calls = 0;
  const lookup = async () => { calls++; return { actions: [] }; };
  for (const hours of [1, 6, 24, 24]) {
    const result = await advanceFinancialDay(day, JSON.parse(JSON.stringify(state)), lookup, clock);
    const next = Date.parse(result.payload.settlement.nextCheckAt);
    assert.equal(next, clock + hours * 3600_000);
    assert.equal(financialDayNeedsWork(day, result.payload, next - 1), false);
    const paused = await advanceFinancialDay(day, result.state, lookup, next - 1);
    assert.deepEqual(paused.state, result.state);
    state = result.state; clock = next;
  }
  assert.equal(calls, 4);
});

test('overflow resolves only retained identities and never claims omitted exclusions are complete', async () => {
  const result = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, {
    ...snapshot(), pendingSwaps: 9, exclusionsIncomplete: true
  }, now), async () => ({ actions: [action('PENDING-A')] }), now);
  assert.equal(result.payload.pendingSwaps, 8);
  assert.equal(result.payload.settlement.status, 'unavailable');
  assert.equal(result.payload.settlement.remaining, 8);
  assert.equal(result.payload.finalized, false);
  await advanceFinancialDay(day, result.state, () => assert.fail('omitted IDs cannot trigger a broad scan'), now + 86400_000);
});

test('read exposes pending legacy-ID reconciliation and its cooldown without advertising day reacquisition', async () => {
  const retryAt = new Date(now + 3600_000).toISOString();
  const result = await readFinancialDay(day, { now: () => now, client: { query: async () => ({ rows: [{
    payload_json: snapshot(), phase: 'done', available_at: retryAt, last_error: 'Budget deferred'
  }] }) } });
  assert.equal(result.loading, false);
  assert.equal(result.refreshing, false);
  assert.equal(result.deferred, true);
  assert.equal(result.error, 'Budget deferred');
  assert.equal(result.progress.phase, 'settlement');
  assert.deepEqual(result.settlement, { status: 'pending', checkedAt: null, nextCheckAt: retryAt, remaining: 1, passCount: 0 });
});

test('payload-only recovery preserves pass backoff and safely bounds legacy pass counters', async () => {
  const first = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, snapshot(), now), async () => ({ actions: [] }), now);
  assert.equal(first.payload.settlement.passCount, 1);
  const later = Date.parse(first.payload.settlement.nextCheckAt);
  const second = await advanceFinancialDay(day, financialDayStateFromSnapshot(day, first.payload, later), async () => ({ actions: [] }), later);
  assert.equal(second.payload.settlement.passCount, 2);
  assert.equal(Date.parse(second.payload.settlement.nextCheckAt), later + 6 * 3600_000);
  for (const value of [-10, 'bad', Infinity, 1.7, Number.MAX_VALUE]) {
    const state = financialDayStateFromSnapshot(day, { ...snapshot(), settlement: { passCount: value } }, now);
    const result = await advanceFinancialDay(day, state, async () => ({ actions: [] }), now);
    assert.ok(Number.isSafeInteger(result.payload.settlement.passCount));
    assert.ok(result.payload.settlement.passCount >= 1);
    assert.ok(Date.parse(result.payload.settlement.nextCheckAt) <= now + 24 * 3600_000);
  }
});

test('fully settled closed snapshots mature to finalized on read without upstream requests', async () => {
  const resolved = { ...snapshot([]), settlement: { status: 'complete', checkedAt: new Date(now).toISOString(), nextCheckAt: null, remaining: 0 } };
  const client = { query: async () => ({ rows: [{ payload_json: resolved, phase: 'done' }] }) };
  assert.equal((await readFinancialDay(day, { client, now: () => now })).finalized, false);
  assert.equal((await readFinancialDay(day, { client, now: () => now + 2 * 86400_000 })).finalized, true);
  assert.equal(financialDayNeedsWork(day, resolved, now + 2 * 86400_000), false);
  await advanceFinancialDay(day, financialDayStateFromSnapshot(day, resolved, now), () => assert.fail('settled days cost zero requests'), now + 2 * 86400_000);
});
