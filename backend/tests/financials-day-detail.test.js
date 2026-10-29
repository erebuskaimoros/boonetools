import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceFinancialDay, financialDetailDay, financialPoolVolume, readFinancialDay, refreshFinancialDayQueue,
  financialDayStateFromSnapshot, financialDayRetryAt } from '../src/shared/financials-day-detail.js';
import { handleFinancials } from '../src/handlers/financials.js';

const day = '2026-10-12', from = Date.parse(`${day}T00:00:00Z`) / 1000, to = from + 86400;
const now = (to + 3 * 86400) * 1000;
const action = (id, seconds, value, extras = {}) => ({ type: 'swap', status: 'success', date: String(BigInt(seconds) * 1000000000n),
  pools: ['BTC.BTC'], in: [{ txID: id, coins: [{ asset: 'BTC.BTC', amount: String(value * 1e8) }] }],
  out: [{ coins: [{ asset: 'THOR.RUNE', amount: '100000000' }] }], metadata: { swap: { inPriceUSD: '10', outPriceUSD: '10', liquidityFee: String(value * 1e8) } }, ...extras });

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
    assert.deepEqual(args, [day, 'UTC', false, new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString()]); return { rows: [{ phase: 'actions', pages: '4' }] };
  } } });
  assert.equal(result.loading, true); assert.equal(result.progress.pages, 4);
});

test('queue bounds provider requests and persists every successful step for restart recovery', async () => {
  const writes = [];
  const client = { query: async (sql, args) => sql.startsWith('select') ? { rows: [{ day, state_json: null }] }
    : (sql.startsWith('update') && writes.push(args), { rows: [] }) };
  let requests = 0;
  await refreshFinancialDayQueue(client, { maxRequests: 2, now: () => now, getJson: async route => {
    requests++;
    return route === '/health' ? { inSync: true, lastAggregated: { timestamp: to } }
      : { intervals: [{ startTime: from, endTime: to, pools: [] }] };
  } });
  assert.equal(requests, 2); assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1][1]).phase, 'actions');
});

test('live refresh scans only the new disjoint interval, merges top ten, and resolves tracked duplicate exclusions', async () => {
  const previousThrough = from + 3600, through = from + 7200;
  let state = { day, from, to, through: previousThrough, phase: 'done', swaps: [
    { txId: 'PRIOR', volumeUsd: 9000, feeUsd: 9000 }, { txId: 'DUPLICATE', volumeUsd: 20, feeUsd: 20 }
  ], pools: ['BTC.BTC', 'ETH.ETH'], poolRows: [], tokens: [], pages: 700,
  unpriced: 1, pending: 1, exclusions: [{ txId: 'SETTLED', kind: 'pending' }, { txId: 'UNPRICED', kind: 'unpriced' }] };
  const calls = [];
  const getJson = async route => {
    calls.push(route);
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: through } };
    if (route.startsWith('/history/earnings')) return { intervals: Array.from({ length: 24 }, (_, i) => ({
      startTime: from + i * 300, endTime: from + (i + 1) * 300, pools: [{ pool: 'BTC.BTC' }] })) };
    if (route.startsWith('/actions')) return { actions: [action('settled', through - 10, 100),
      action('duplicate', through - 20, 2), action('unpriced', through - 30, 1, { metadata: {} }),
      action('boundary', previousThrough, 500), action('old', previousThrough - 1, 1000000)] };
    return { intervals: [{ startTime: from, endTime: through, totalVolumeUSD: '10000', totalVolume: '500000000' }] };
  };
  let payload;
  for (let i = 0; i < 5; i++) {
    const result = await advanceFinancialDay(day, state, getJson, (through + 1) * 1000);
    state = result.state; payload = result.payload;
    if (i < 4) assert.equal(payload, null, 'old payload must remain published until delta action and pool coverage both complete');
  }
  assert.equal(calls.filter(route => route.startsWith('/actions')).length, 1, 'no replay of 700 historical pages');
  assert.equal(state.actionFrom, previousThrough); assert.equal(state.pages, 701);
  assert.deepEqual(payload.swaps.map(row => row.txId), ['PRIOR', 'BOUNDARY', 'SETTLED', 'DUPLICATE']);
  assert.equal(payload.pendingSwaps, 0); assert.equal(payload.unpricedSwaps, 1);
  assert.deepEqual(payload.excludedSwaps, [{ txId: 'UNPRICED', kind: 'unpriced' }]);
  assert.equal(payload.finalized, false); assert.equal(payload.partial, true);
  assert.deepEqual(payload.pools.map(row => row.asset), ['BTC.BTC', 'ETH.ETH'], 'retain prior pools even when absent from new earnings');
});

const storedDay = (through, pools) => ({ payload_json: { day, through: new Date(through * 1000).toISOString(),
  swaps: [], pools, pendingSwaps: 0, unpricedSwaps: 0 }, phase: 'done', pages: '1', last_error: null,
  available_at: new Date(now).toISOString() });

test('a closed day ranks Pool Analysis daily totals over its stored pool snapshot', async () => {
  // 2026-10-27's stored top ten lost BTC.BTC and ETH.ETH to stale zero buckets.
  // Pool Analysis keeps the completed day from the same Midgard pool history.
  const client = { query: async sql => {
    if (/financials_day_rankings/.test(sql)) return { rows: [storedDay(to, [
      { asset: 'TRON.TRX', volumeUsd: 6611915.06, volumeRune: 10492844.57621485 },
      { asset: 'BNB.BNB', volumeUsd: 5000, volumeRune: 8000 }])] };
    if (/pool_analysis_daily/.test(sql)) return { rows: [
      { asset: 'ETH.ETH', volume_usd_e2: '1516321771', volume_rune_e8: '2400000000000000' },
      { asset: 'BTC.BTC', volume_usd_e2: '787593530', volume_rune_e8: '1246000000000000' },
      { asset: 'TRON.TRX', volume_usd_e2: '661191506', volume_rune_e8: '1049284457621485' },
      { asset: 'GAIA.ATOM', volume_usd_e2: '0', volume_rune_e8: '0' }] };
    if (/financials_swap_ledger/.test(sql)) return { rows: [] }; // Not a stream-covered day.
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await readFinancialDay(day, { now: () => now, client });
  assert.deepEqual(result.pools.map(row => [row.asset, row.volumeUsd, row.volumeRune]), [
    ['ETH.ETH', 15163217.71, 24000000], ['BTC.BTC', 7875935.3, 12460000],
    ['TRON.TRX', 6611915.06, 10492844.57621485], ['BNB.BNB', 5000, 8000]]);
});

test('a partial day ranks each pool\'s latest Pool Analysis prefix at or before its snapshot horizon', async () => {
  const through = from + 14 * 3600;
  const client = { query: async (sql, args) => {
    if (/financials_day_rankings/.test(sql)) return { rows: [storedDay(through, [])] };
    if (/pool_analysis_intraday_snapshots/.test(sql)) {
      assert.ok(args.some(value => new Date(value).getTime() === through * 1000), 'bounded by the stored snapshot horizon');
      return { rows: [{ asset: 'BTC.BTC', volume_usd_e2: '400000000', volume_rune_e8: '630000000000000' }] };
    }
    if (/financials_swap_ledger/.test(sql)) return { rows: [] }; // Not a stream-covered day.
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await readFinancialDay(day, { now: () => (through + 600) * 1000, client });
  assert.deepEqual(result.pools.map(row => [row.asset, row.volumeUsd, row.volumeRune]), [['BTC.BTC', 4000000, 6300000]]);
});

test('the collector requests Midgard pool history only for pools Pool Analysis does not track', async () => {
  const state = { day, from, to, through: to, phase: 'pools', swaps: [], pools: ['BNB.BNB', 'BTC.BTC'], poolRows: [],
    tokens: [], pages: 1, unpriced: 0, pending: 0, exclusions: [] };
  const writes = [], requests = [];
  const client = { query: async (sql, args) => {
    if (/pool_analysis_sync_state/.test(sql)) return { rows: [{ asset: 'BTC.BTC' }] };
    if (sql.trimStart().startsWith('select')) return { rows: [{ day, state_json: state, payload_json: null, background: true }] };
    if (sql.trimStart().startsWith('update')) writes.push(args);
    return { rows: [] };
  } };
  await refreshFinancialDayQueue(client, { now: () => now, getJson: async route => {
    requests.push(new URL(route, 'https://example.test').searchParams.get('pool'));
    return { intervals: [{ startTime: from, endTime: to, totalVolumeUSD: '500000', totalVolume: '800000000000' }] };
  } });
  assert.deepEqual(requests, ['BNB.BNB']);
  const saved = JSON.parse(writes[0][1]);
  assert.equal(saved.phase, 'done');
  assert.deepEqual(saved.poolRows.map(row => row.asset), ['BNB.BNB']);
});

test('unchanged live watermark costs only health and preserves the previous observed snapshot', async () => {
  const state = financialDayStateFromSnapshot(day, { through: new Date((from + 3600) * 1000).toISOString(),
    observedAt: new Date((from + 4000) * 1000).toISOString(), swaps: [], pools: [], pendingSwaps: 0, unpricedSwaps: 0 }, now);
  let calls = 0;
  const result = await advanceFinancialDay(day, state, async route => {
    calls++; assert.equal(route, '/health'); return { inSync: true, lastAggregated: { timestamp: from + 3300 } };
  }, now);
  assert.equal(calls, 1); assert.deepEqual(result.state, state);
  assert.equal(result.payload.through, new Date((from + 3600) * 1000).toISOString());
  assert.equal(result.payload.observedAt, state.observedAt);
});

test('legacy count-only exclusions survive delta scans without claiming resolved finality', async () => {
  let state = financialDayStateFromSnapshot(day, { through: new Date((to - 300) * 1000).toISOString(),
    swaps: [], pools: [], pendingSwaps: 3, unpricedSwaps: 2 }, now);
  let payload;
  for (let i = 0; i < 4; i++) {
    const result = await advanceFinancialDay(day, state, async route => route === '/health'
      ? { inSync: true, lastAggregated: { timestamp: to } }
      : route.startsWith('/history/earnings') ? { intervals: [{ startTime: to - 300, endTime: to, pools: [] }] }
        : { actions: [] }, now);
    state = result.state; payload = result.payload;
  }
  assert.equal(payload.partial, false); assert.equal(payload.finalized, false);
  assert.equal(payload.pendingSwaps, 3); assert.equal(payload.unpricedSwaps, 2);
  assert.equal(payload.exclusionsIncomplete, true);
});

test('unresolved identity retention is bounded and duplicates do not inflate tracked counts', async () => {
  const state = { day, from, to, through: to, phase: 'actions', swaps: [], pools: [], poolRows: [], pages: 0, tokens: [], unpriced: 0, pending: 0 };
  const actions = Array.from({ length: 520 }, (_, index) => action(`pending-${index}`, from + 10, 1, { status: 'pending' }));
  actions.push(action('pending-0', from + 10, 1, { status: 'pending' }), action('old', from - 1, 1));
  const result = await advanceFinancialDay(day, state, async () => ({ actions }), now);
  assert.equal(result.state.exclusions.length, 512); assert.equal(result.state.pending, 520);
  assert.equal(result.state.exclusionsIncomplete, true);
});

test('a known successful top-ten transaction is not reclassified by a stale pending duplicate', async () => {
  const state = { day, from, to, through: to, phase: 'actions',
    swaps: [{ txId: 'SETTLED', volumeUsd: 1000 }], pools: [], poolRows: [], pages: 0, tokens: [], unpriced: 0, pending: 0 };
  const result = await advanceFinancialDay(day, state, async () => ({ actions: [
    action('settled', from + 10, 1, { status: 'pending' }), action('old', from - 1, 1)
  ] }), now);
  assert.equal(result.state.pending, 0);
  assert.deepEqual(result.state.exclusions, []);
});

test('queue stops between requests when its visitor lease expires, preserving the last checkpoint', async () => {
  let clock = now, calls = 0;
  const writes = [];
  const client = { query: async (sql, args) => sql.startsWith('select') ? { rows: [{ day, state_json: null, requested_at: new Date(now) }] }
    : (sql.startsWith('update') && writes.push(args), { rows: [{ requested_at: new Date(now) }] }) };
  await refreshFinancialDayQueue(client, { now: () => clock, getJson: async () => {
    calls++; clock += 120_001; return { inSync: true, lastAggregated: { timestamp: to } };
  } });
  assert.equal(calls, 1); assert.equal(writes.length, 1); assert.equal(JSON.parse(writes[0][1]).phase, 'earnings');
});

test('queue honors fresh visitor lease renewals while a bounded batch is in flight', async () => {
  let clock = now, calls = 0;
  const client = { query: async sql => sql.startsWith('select') ? { rows: [{ day, state_json: null, requested_at: new Date(now) }] }
    : { rows: [{ requested_at: new Date(clock) }] } };
  await refreshFinancialDayQueue(client, { maxRequests: 2, now: () => clock, getJson: async route => {
    calls++; clock += 120_001;
    return route === '/health' ? { inSync: true, lastAggregated: { timestamp: to } }
      : { intervals: [{ startTime: from, endTime: to, pools: [] }] };
  } });
  assert.equal(calls, 2);
});

test('budget deferral persists its real retry horizon without replacing checkpoints or the last-good payload', async () => {
  const writes = [], retryAt = new Date(now + 6 * 3600_000).toISOString();
  const client = { query: async (sql, args) => sql.startsWith('select') ? { rows: [{ day, state_json: null }] }
    : (sql.startsWith('update') && writes.push({ sql, args }), { rows: [] }) };
  await refreshFinancialDayQueue(client, { now: () => now, getJson: async () => {
    throw Object.assign(new Error('Midgard daily budget deferred'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt, skipProvider: true });
  } });
  assert.equal(writes.length, 1); assert.equal(writes[0].args[2], retryAt);
  assert.doesNotMatch(writes[0].sql, /state_json\s*=|payload_json\s*=/);
});

test('short budget retries resume at the provider horizon while unclassified failures retain a minute backoff', () => {
  assert.equal(financialDayRetryAt({ retryAt: new Date(now + 10_000).toISOString() }, now), now + 10_000);
  assert.equal(financialDayRetryAt({ retryAfterSeconds: 90 }, now), now + 90_000);
  assert.equal(financialDayRetryAt(new Error('Temporary failure'), now), now + 60_000);
});

// Reads and the collector consult Pool Analysis; its DDL stays inside the rollback-only schema.
async function poolAnalysisTables(client, readFile) {
  for (const migration of ['051_pool_analysis.sql', '066_pool_analysis_intraday_snapshots.sql']) {
    const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
    await client.query(sql.replace(/^begin;|commit;\s*$/gi, '').replaceAll('public.', ''));
  }
}

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
    await client.query(await readFile(new URL('../migrations/072_financials_background_rosters.sql', import.meta.url), 'utf8'));
    await poolAnalysisTables(client, readFile);
    await client.query(await readFile(new URL('../migrations/073_financials_swap_candidates.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../migrations/075_financials_local_fee_rankings.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../migrations/076_financials_fee_candidates.sql', import.meta.url), 'utf8'));
    // This test isolates the visitor lane; the managed current day is cooling.
    await client.query(`insert into financials_day_rankings (day, background, available_at)
      values ((now() at time zone 'UTC')::date, true, now() + interval '1 day')`);
    assert.equal((await readFinancialDay(day, { client })).loading, true);
    let fail = false;
    // The real queue uses database wall-clock eligibility, so retry horizons
    // must use the same wall clock in this SQL integration test.
    const options = { maxRequests: 1, getJson: async route => {
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
    await client.query("update financials_day_rankings set available_at = now() where day = $1", [day]);
    fail = false;
    await refreshFinancialDayQueue(client, { ...options, maxRequests: 4 });
    const result = await readFinancialDay(day, { client });
    assert.equal(result.loading, false); assert.equal(result.finalized, true); assert.deepEqual(result.swaps, []);
    await client.query('update financials_day_rankings set available_at = now() where day = $1', [day]);
    await refreshFinancialDayQueue(client, { getJson: () => { throw new Error('final cache must not reacquire'); } });
    assert.equal((await readFinancialDay(day, { client })).error, '');
  } finally { await client.query('rollback'); await client.end(); }
});

test('Postgres queue freezes provisional closed days, pauses abandoned scans and resumes exact checkpoints', {
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
    await client.query(`create schema financial_day_budget_test_${process.pid}`);
    await client.query(`set local search_path to financial_day_budget_test_${process.pid}`);
    await client.query("set local time zone 'America/New_York'");
    await client.query(await readFile(new URL('../migrations/068_financials_day_details.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../migrations/072_financials_background_rosters.sql', import.meta.url), 'utf8'));
    await poolAnalysisTables(client, readFile);
    await client.query(await readFile(new URL('../migrations/073_financials_swap_candidates.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../migrations/075_financials_local_fee_rankings.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../migrations/076_financials_fee_candidates.sql', import.meta.url), 'utf8'));
    await client.query(`insert into financials_day_rankings (day, background, available_at)
      values ((now() at time zone 'UTC')::date, true, now() + interval '1 day')`);
    const complete = { day, through: new Date(to * 1000).toISOString(), observedAt: new Date(now).toISOString(),
      partial: false, finalized: false, pendingSwaps: 82, unpricedSwaps: 1, swaps: [], pools: [] };
    await client.query(`insert into financials_day_rankings(day, payload_json, last_error) values ($1, $2, 'Old rate limit')`, [day, complete]);
    let calls = 0;
    await refreshFinancialDayQueue(client, { getJson: () => { calls++; throw new Error('closed day must not reacquire'); } });
    assert.equal(calls, 0);
    const frozen = await readFinancialDay(day, { client });
    assert.equal(frozen.refreshing, false); assert.equal(frozen.error, ''); assert.equal(frozen.finalized, false);
    assert.equal(frozen.pendingSwaps, 82); assert.equal(frozen.observedAt, complete.observedAt);

    const coldDay = '2026-10-11', coldFrom = from - 86400;
    const checkpoint = { day: coldDay, from: coldFrom, to: from, through: from, phase: 'actions',
      token: 'saved-cursor', tokens: ['saved-cursor'], pages: 121, swaps: [], pools: [], poolRows: [], pending: 0, unpriced: 0 };
    await client.query(`insert into financials_day_rankings(day, state_json, requested_at) values ($1, $2, now() - interval '10 minutes')`, [coldDay, checkpoint]);
    await refreshFinancialDayQueue(client, { getJson: () => { calls++; throw new Error('abandoned must not run'); } });
    assert.equal(calls, 0);
    assert.deepEqual((await client.query('select state_json from financials_day_rankings where day = $1', [coldDay])).rows[0].state_json, checkpoint);
    await readFinancialDay(coldDay, { client });
    const retryAt = new Date(Date.now() + 4 * 3600_000).toISOString();
    await refreshFinancialDayQueue(client, { maxRequests: 1, getJson: route => {
      calls++;
      assert.equal(new URL(route, 'https://example.test').searchParams.get('nextPageToken'), 'saved-cursor');
      throw Object.assign(new Error('Budget deferred'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt });
    } });
    assert.equal(calls, 1);
    const deferred = await readFinancialDay(coldDay, { client });
    assert.equal(deferred.deferred, true); assert.equal(deferred.retryAt, retryAt);
    const saved = (await client.query('select state_json, available_at from financials_day_rankings where day = $1', [coldDay])).rows[0];
    assert.deepEqual(saved.state_json, checkpoint); assert.equal(saved.available_at.toISOString(), retryAt);
    await refreshFinancialDayQueue(client, { getJson: () => { calls++; throw new Error('must wait for budget horizon'); } });
    assert.equal(calls, 1);
    await client.query('update financials_day_rankings set available_at = now() where day = $1', [coldDay]);
    await refreshFinancialDayQueue(client, { maxRequests: 2, getJson: async () => { calls++; return { actions: [] }; } });
    const resumed = await readFinancialDay(coldDay, { client });
    assert.equal(resumed.loading, false); assert.equal(resumed.progress.pages, 122); assert.equal(resumed.error, '');
  } finally { await client.query('rollback'); await client.end(); }
});
