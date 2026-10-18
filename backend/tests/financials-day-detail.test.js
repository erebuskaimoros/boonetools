import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceFinancialDay, financialDetailDay, financialPoolVolume, readFinancialDay, refreshFinancialDayQueue } from '../src/shared/financials-day-detail.js';
import { handleFinancials } from '../src/handlers/financials.js';

const day = '2026-10-12', from = Date.parse(`${day}T00:00:00Z`) / 1000, to = from + 86400;
const now = (to + 3 * 86400) * 1000;
const action = (id, seconds, value, extras = {}) => ({ type: 'swap', status: 'success', date: String(BigInt(seconds) * 1000000000n),
  pools: ['BTC.BTC'], in: [{ txID: id, coins: [{ asset: 'BTC.BTC', amount: String(value * 1e8) }] }],
  out: [{ coins: [{ asset: 'THOR.RUNE', amount: '100000000' }] }], metadata: { swap: { inPriceUSD: '10' } }, ...extras });

test('UTC date validation rejects rollover dates, future dates, and pre-mainnet days', () => {
  assert.deepEqual(financialDetailDay(day, now), { day, from, to });
  for (const invalid of ['2026-02-30', '2026-10-99', '2020-01-01', '2026-10-17', '../foo', '', '2026-1-1']) {
    assert.throws(() => financialDetailDay(invalid, now));
  }
});

test('full scan ranks across pages, includes midnight, excludes the next day, and deduplicates top transactions', async () => {
  const calls = [];
  const getJson = async route => {
    calls.push(route);
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: to } };
    if (route.startsWith('/history/earnings')) return { intervals: [{ startTime: from, endTime: to, pools: [{ pool: 'BTC.BTC' }, { pool: 'ETH.ETH' }, { pool: 'dev_fund_reward' }] }] };
    if (route.startsWith('/actions')) {
      const params = new URL(route, 'https://example.test').searchParams;
      assert.equal(params.get('timestamp'), params.has('nextPageToken') ? null : String(to));
      if (!params.get('nextPageToken')) return { actions: [action('future', to, 100000), ...Array.from({ length: 12 }, (_, i) => action(`tx${i}`, from + 100 - i, i + 1))], meta: { nextPageToken: 'second' } };
      return { actions: [action('tx11', from + 89, 12), action('midnight', from, 100), action('old', from - 1, 100000)], meta: { nextPageToken: 'unused' } };
    }
    return { intervals: [{ startTime: from, endTime: to, totalVolumeUSD: route.includes('ETH') ? '22200' : '11100', totalVolume: '300000000' }] };
  };
  let state = null, payload;
  for (let i = 0; i < 6; i++) {
    const result = await advanceFinancialDay(day, state, getJson, now); state = result.state; payload = result.payload;
    if (i < 5) assert.equal(payload, null, 'do not present a partial scan as the top ten');
  }
  assert.equal(payload.swaps.length, 10);
  assert.equal(payload.swaps[0].txId, 'MIDNIGHT');
  assert.equal(payload.swaps[0].volumeUsd, 1000);
  assert.equal(payload.swaps.filter(row => row.txId === 'TX11').length, 1);
  assert.ok(!payload.swaps.some(row => ['FUTURE', 'OLD'].includes(row.txId)));
  assert.deepEqual(payload.pools.map(row => [row.asset, row.volumeUsd]), [['ETH.ETH', 222], ['BTC.BTC', 111]]);
  assert.equal(payload.finalized, true);
  assert.equal(payload.partial, false);
  assert.equal(calls.length, 6);
});

test('live horizon is pinned to indexed five-minute coverage and never moves while paging', async () => {
  const first = await advanceFinancialDay(day, null, async () => ({ inSync: true, lastAggregated: { timestamp: from + 7201 } }), (from + 8000) * 1000);
  assert.equal(first.state.through, from + 7200);
  await advanceFinancialDay(day, first.state, async route => {
    const params = new URL(route, 'https://example.test').searchParams;
    assert.equal(params.get('interval'), '5min'); assert.equal(params.get('count'), '24');
    return { intervals: Array.from({ length: 24 }, (_, i) => ({ startTime: from + i * 300, endTime: from + (i + 1) * 300, pools: [] })) };
  }, (from + 20000) * 1000);
});

test('incomplete pool coverage and missing amounts fail closed; true zero is retained', () => {
  const state = { from, through: to };
  assert.throws(() => financialPoolVolume({ intervals: [] }, state, 'BTC.BTC'), /incomplete/);
  assert.throws(() => financialPoolVolume({ intervals: [{ startTime: from, endTime: to, totalVolume: '0' }] }, state, 'BTC.BTC'), /incomplete/);
  assert.deepEqual(financialPoolVolume({ intervals: [{ startTime: from, endTime: to, totalVolume: '0', totalVolumeUSD: '0' }] }, state, 'BTC.BTC'), { asset: 'BTC.BTC', volumeRune: 0, volumeUsd: 0 });
});

test('cursor failures leave the checkpoint unchanged; missing prices and pending swaps are disclosed', async () => {
  const state = { day, from, to, through: to, phase: 'actions', swaps: [], pools: [], poolRows: [], pages: 1, tokens: ['repeat'], token: 'repeat', unpriced: 0, pending: 0 };
  await assert.rejects(advanceFinancialDay(day, state, async () => ({ actions: [action('one', from + 10, 1)], meta: { nextPageToken: 'repeat' } }), now), /did not advance/);
  assert.deepEqual(state.swaps, []);
  assert.equal(state.pages, 1);
  const result = await advanceFinancialDay(day, state, async () => ({ actions: [action('one', from + 10, 1, { metadata: {} }), action('pending', from + 5, 1, { status: 'pending' }), action('old', from - 1, 1)] }), now);
  assert.equal(result.state.unpriced, 1); assert.equal(result.state.pending, 1); assert.equal(result.payload, null);
});

test('day endpoint validates before enqueueing and public reads only use the database', async () => {
  let queued;
  const response = await handleFinancials({}, new URL(`https://example.test/financials?day=${day}`), { now: () => now,
    readDay: async value => { queued = value; return { day: value, loading: true }; } });
  assert.equal(response.status, 200); assert.equal(queued, day);
  const invalid = await handleFinancials({}, new URL('https://example.test/financials?day=2026-02-30'), { readDay: () => { throw new Error('must not enqueue'); } });
  assert.equal(invalid.status, 400);
  const result = await readFinancialDay(day, { now: () => now, client: { query: async (_sql, args) => {
    assert.deepEqual(args, [day]); return { rows: [{ phase: 'actions', pages: '4' }] };
  } } });
  assert.equal(result.loading, true); assert.equal(result.progress.pages, 4);
});

test('queue bounds provider requests and persists every successful step for restart recovery', async () => {
  const writes = [];
  const client = { query: async (sql, args) => sql.startsWith('select') ? { rows: [{ day, state_json: null }] } : (writes.push(args), { rows: [] }) };
  let requests = 0;
  await refreshFinancialDayQueue(client, { maxRequests: 2, now: () => now, getJson: async route => {
    requests++;
    return route === '/health' ? { inSync: true, lastAggregated: { timestamp: to } }
      : { intervals: [{ startTime: from, endTime: to, pools: [] }] };
  } });
  assert.equal(requests, 2); assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1][1]).phase, 'actions');
});

test('Postgres migration, cold enqueue, resumable worker, last-good errors and final cache work together', {
  skip: !process.env.ACQUISITION_TEST_DATABASE_URL
}, async () => {
  const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const { default: pg } = await import('pg');
  const { readFile } = await import('node:fs/promises');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    // Isolated transactional schema: safe even alongside other integration tests.
    await client.query(`create schema financial_day_test_${process.pid}`);
    await client.query(`set local search_path to financial_day_test_${process.pid}`);
    await client.query(await readFile(new URL('../migrations/068_financials_day_details.sql', import.meta.url), 'utf8'));
    assert.equal((await readFinancialDay(day, { client })).loading, true);
    let fail = false;
    const options = { now: () => now, maxRequests: 1, getJson: async route => {
      if (fail) throw new Error('Temporary source failure');
      if (route === '/health') return { inSync: true, lastAggregated: { timestamp: to } };
      if (route.startsWith('/history/earnings')) return { intervals: [{ startTime: from, endTime: to, pools: [] }] };
      return { actions: [] };
    } };
    await refreshFinancialDayQueue(client, options);
    assert.equal((await readFinancialDay(day, { client })).progress.phase, 'earnings');
    fail = true;
    await refreshFinancialDayQueue(client, options);
    assert.match((await readFinancialDay(day, { client })).error, /Temporary/);
    // The queue's retry timestamp is authoritative, not visitor polling.
    let calls = 0;
    await refreshFinancialDayQueue(client, { ...options, getJson: () => { calls++; throw new Error('must not retry yet'); } });
    assert.equal(calls, 0);
    await client.query("update financials_day_details set available_at = now() where day = $1", [day]);
    fail = false;
    await refreshFinancialDayQueue(client, { ...options, maxRequests: 4 });
    const result = await readFinancialDay(day, { client });
    assert.equal(result.loading, false); assert.equal(result.finalized, true); assert.deepEqual(result.swaps, []);
    await client.query('update financials_day_details set available_at = now()');
    await refreshFinancialDayQueue(client, { getJson: () => { throw new Error('final cache must not reacquire'); } });
    assert.equal((await readFinancialDay(day, { client })).error, '');
  } finally { await client.query('rollback'); await client.end(); }
});
