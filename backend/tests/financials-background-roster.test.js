import assert from 'node:assert/strict';
import test from 'node:test';
import * as detail from '../src/shared/financials-day-detail.js';

const day = '2026-10-22';
const from = Date.parse(`${day}T00:00:00Z`) / 1000;
const now = (from + 12 * 3600 + 4 * 60) * 1000;
const health = { inSync: true, lastAggregated: { timestamp: from + 12 * 3600 + 3 * 60 } };

test('managed horizons allow Pool Analysis three minutes to save quarter-hour prefixes', async () => {
  const early = await detail.advanceFinancialDay(day, null, async () => health,
    (from + 12 * 3600 + 2 * 60) * 1000, { background: true });
  assert.equal(early.state.through, from + 11 * 3600 + 45 * 60);
  const ready = await detail.advanceFinancialDay(day, null, async () => health, now, { background: true });
  assert.equal(ready.state.through, from + 12 * 3600);
  const providerBehind = await detail.advanceFinancialDay(day, null, async () => ({
    inSync: true, lastAggregated: { timestamp: from + 11 * 3600 + 59 * 60 }
  }), now, { background: true });
  assert.equal(providerBehind.state.through, from + 11 * 3600 + 45 * 60);
});

test('managed refreshes follow quarter-hour boundaries plus grace without elapsed-time drift', () => {
  assert.equal(detail.financialDayRosterReadyAt(day, from * 1000), (from + 18 * 60) * 1000);
  assert.equal(detail.financialDayRosterReadyAt(day, now), now);
  assert.equal(detail.financialDayRefreshAt((from + 12 * 3600 + 2 * 60) * 1000, { background: true }),
    (from + 12 * 3600 + 3 * 60) * 1000);
  assert.equal(detail.financialDayRefreshAt(now, { background: true }), (from + 12 * 3600 + 18 * 60) * 1000);
  assert.equal(detail.financialDayRefreshAt(now), now + detail.FINANCIAL_DAY_REFRESH_MS);
});

test('promoted five-minute snapshots never regress to an older quarter-hour watermark', async () => {
  const state = detail.financialDayStateFromSnapshot(day, {
    through: new Date((from + 12 * 3600 + 5 * 60) * 1000).toISOString(), swaps: [], pools: [],
    observedAt: new Date(now).toISOString()
  }, now + 10 * 60_000);
  const result = await detail.advanceFinancialDay(day, state, async () => health, now + 10 * 60_000, { background: true });
  assert.deepEqual(result.state, state);
  assert.equal(result.payload.through, new Date(state.through * 1000).toISOString());
});

test('current, closing and visitor lanes share one bounded batch instead of starving one another', async () => {
  const rows = [
    { day, background: true },
    { day: '2026-10-21', background: true },
    { day: '2026-10-20', background: false, requested_at: new Date(now) }
  ];
  const writes = [];
  const client = { query: async (sql, args) => {
    if (/^select/.test(sql.trim())) return { rows };
    if (/^update/.test(sql.trim())) writes.push(args);
    return { rows: [] };
  } };
  let calls = 0;
  await detail.refreshFinancialDayQueue(client, { maxRequests: 3, now: () => now,
    getJson: async route => { calls++; assert.equal(route, '/health'); return health; } });
  assert.equal(calls, 3);
  assert.deepEqual(writes.map(args => args[0]), rows.map(row => row.day));
  assert.ok(writes.every(args => JSON.parse(args[1]).phase === 'earnings'));
});

test('managed background batches stop on cancellation without losing the completed checkpoint', async () => {
  const controller = new AbortController();
  const writes = [];
  const client = { query: async (sql, args) => {
    if (/^select/.test(sql.trim())) return { rows: [{ day, background: true }] };
    if (/^update/.test(sql.trim())) writes.push(args);
    return { rows: [] };
  } };
  let calls = 0;
  await detail.refreshFinancialDayQueue(client, { signal: controller.signal, now: () => now,
    getJson: async () => { calls++; controller.abort(); return health; } });
  assert.equal(calls, 1);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0][1]).phase, 'earnings');
});

test('closed managed days with unresolved exclusions require zero provider requests', async () => {
  let calls = 0;
  const client = { query: async sql => /^select/.test(sql.trim()) ? { rows: [{
    day: '2026-10-21', background: true,
    payload_json: { through: new Date(from * 1000).toISOString(), pendingSwaps: 5, finalized: false }
  }] } : { rows: [] } };
  await detail.refreshFinancialDayQueue(client, { now: () => now, getJson: async () => { calls++; } });
  assert.equal(calls, 0);
});

test('delta earnings discovery retains the old pool universe and requests only newly indexed buckets', async () => {
  const through = from + 12 * 3600;
  const state = { day, from, to: from + 86400, through, actionFrom: through - 900, phase: 'earnings',
    swaps: [], pools: ['ETH.ETH'], poolRows: [], tokens: [], pages: 45, pending: 0, unpriced: 0 };
  const result = await detail.advanceFinancialDay(day, state, async route => {
    const url = new URL(route, 'https://example.test');
    assert.equal(url.searchParams.get('from'), String(through - 900));
    assert.equal(url.searchParams.get('count'), '3');
    return { intervals: [{ startTime: through - 900, endTime: through, pools: [{ pool: 'BTC.BTC' }] }] };
  }, now, { background: true });
  assert.deepEqual(result.state.pools, ['BTC.BTC', 'ETH.ETH']);
});

async function withRosterDatabase(name, run) {
  const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const { default: pg } = await import('pg');
  const { readFile } = await import('node:fs/promises');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema financial_roster_${process.pid}_${name}`);
    await client.query(`set local search_path to financial_roster_${process.pid}_${name}`);
    await client.query("set local time zone 'America/New_York'");
    // Pool Analysis DDL stays inside this rollback-only schema.
    for (const migration of ['051_pool_analysis.sql', '066_pool_analysis_intraday_snapshots.sql',
      '068_financials_day_details.sql', '072_financials_background_rosters.sql', '073_financials_swap_candidates.sql', '075_financials_local_fee_rankings.sql', '076_financials_fee_candidates.sql', '077_financials_pool_swap_fees.sql', '078_financials_verification_pause.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^begin;|commit;\s*$/gi, '').replaceAll('public.', ''));
    }
    await run(client);
  } finally { await client.query('rollback'); await client.end(); }
}

const postgres = { skip: !process.env.ACQUISITION_TEST_DATABASE_URL };

test('Postgres startup, no-viewer progress, exact restart cursor, rollover and targeted settlement are durable', postgres, async () => {
  await withRosterDatabase('lifecycle', async client => {
    let clock = (from + 5 * 60) * 1000;
    let calls = [];
    const options = { now: () => clock, maxRequests: 1, getJson: async route => {
      calls.push(route);
      if (route === '/health') return { inSync: true, lastAggregated: { timestamp: clock / 1000 } };
      if (route.startsWith('/history/earnings')) {
        const params = new URL(route, 'https://example.test').searchParams;
        const start = Number(params.get('from'));
        const seconds = params.get('interval') === 'day' ? 86400 : 300 * Number(params.get('count'));
        return { intervals: [{ startTime: start, endTime: start + seconds, pools: [] }] };
      }
      return { actions: [] };
    } };
    await detail.refreshFinancialDayQueue(client, options);
    const initial = (await client.query('select day::text, background, available_at from financials_day_rankings')).rows;
    assert.equal(initial.length, 1); assert.equal(initial[0].day, day); assert.equal(initial[0].background, true);
    assert.equal(initial[0].available_at.getTime(), (from + 18 * 60) * 1000);
    assert.equal(calls.length, 0, 'do not poll health while the first managed prefix is impossible');

    clock = (from + 18 * 60) * 1000;
    await client.query("update financials_day_rankings set requested_at = $1::timestamptz - interval '1 hour'", [new Date(clock)]);
    await detail.refreshFinancialDayQueue(client, options);
    let stored = (await client.query('select * from financials_day_rankings where day = $1', [day])).rows[0];
    assert.equal(stored.state_json.phase, 'earnings'); assert.equal(stored.state_json.through, from + 900);
    assert.equal(stored.payload_json, null);
    await detail.refreshFinancialDayQueue(client, options);
    assert.equal((await client.query('select state_json from financials_day_rankings where day = $1', [day])).rows[0].state_json.phase, 'actions');
    const afterRestart = [];
    await detail.refreshFinancialDayQueue(client, { ...options, maxRequests: 2, getJson: async route => {
      afterRestart.push(route); assert.ok(route.startsWith('/actions'));
      return { actions: [] };
    } });
    assert.equal(afterRestart.length, 1, 'restart resumes actions, never replays health/earnings');
    stored = (await client.query('select * from financials_day_rankings where day = $1', [day])).rows[0];
    assert.equal(stored.payload_json.partial, true); assert.equal(stored.payload_json.through, new Date((from + 900) * 1000).toISOString());
    assert.equal(stored.available_at.getTime(), (from + 33 * 60) * 1000);

    // Keep the saved prefix and exclusions, then cross UTC midnight with no
    // new public read. The old day must finish while the new day starts empty.
    const prefix = { ...stored.payload_json, through: new Date((from + 86400 - 900) * 1000).toISOString(),
      pendingSwaps: 2, excludedSwaps: [{ txId: 'PENDING-A', kind: 'pending' }, { txId: 'PENDING-B', kind: 'pending' }], finalized: false };
    await client.query(`update financials_day_rankings set state_json = null, payload_json = $2, available_at = $3 where day = $1`,
      [day, prefix, new Date((from + 86400) * 1000)]);
    clock = (from + 86400 + 4 * 60) * 1000;
    calls = [];
    await detail.refreshFinancialDayQueue(client, { ...options, maxRequests: 10 });
    stored = (await client.query('select * from financials_day_rankings where day = $1', [day])).rows[0];
    assert.equal(stored.payload_json.partial, false);
    assert.equal(stored.payload_json.finalized, false, 'acquisition completion must not claim settlement finality');
    assert.equal(stored.payload_json.pendingSwaps, 2);
    assert.equal(stored.payload_json.through, new Date((from + 86400) * 1000).toISOString());
    const actionRoutes = calls.filter(route => route.startsWith('/actions'));
    assert.equal(actionRoutes.filter(route => !new URL(route, 'https://example.test').searchParams.has('txid')).length, 1,
      'only the disjoint closing interval is acquired, never the whole day again');
    assert.deepEqual(actionRoutes.filter(route => new URL(route, 'https://example.test').searchParams.has('txid'))
      .map(route => new URL(route, 'https://example.test').searchParams.get('txid')), ['PENDING-A', 'PENDING-B']);
    const next = (await client.query('select * from financials_day_rankings where day = $1::date + 1', [day])).rows[0];
    assert.equal(next.background, true); assert.equal(next.state_json, null); assert.equal(next.payload_json, null);
    assert.equal(next.available_at.getTime(), (from + 86400 + 18 * 60) * 1000);
    calls = [];
    await client.query('update financials_day_rankings set available_at = $2 where day = $1', [day, new Date(clock)]);
    await detail.refreshFinancialDayQueue(client, options);
    assert.equal(calls.length, 0, 'closed-day IDs honor whole-pass backoff and new day waits until its first prefix');
    assert.deepEqual((await client.query('select payload_json from financials_day_rankings where day = $1', [day])).rows[0].payload_json, stored.payload_json);
  });
});

test('Postgres promotion preserves yesterday cooldown and checkpoint without sweeping old visitor scans', postgres, async () => {
  await withRosterDatabase('promotion', async client => {
    const retryAt = new Date(now + 6 * 3600_000);
    const checkpoint = { phase: 'actions', pages: 624, token: 'durable-cursor', tokens: ['durable-cursor'] };
    for (const [date, pages] of [['2026-10-21', 624], ['2026-10-20', 346]]) {
      await client.query(`insert into financials_day_rankings (day, state_json, requested_at, available_at, last_error)
        values ($1, $2, $3, $4, 'Budget deferred')`, [date, { ...checkpoint, pages }, new Date(now - 10 * 60_000), retryAt]);
    }
    let calls = 0;
    await detail.refreshFinancialDayQueue(client, { now: () => now, maxRequests: 1, getJson: async () => { calls++; return health; } });
    assert.equal(calls, 1, 'only today is eligible; yesterday remains deferred');
    const rows = (await client.query('select day::text, background, state_json, requested_at, available_at, last_error from financials_day_rankings order by day')).rows;
    assert.deepEqual(rows.map(row => [row.day, row.background]), [['2026-10-20', false], ['2026-10-21', true], [day, true]]);
    assert.deepEqual(rows[1].state_json, checkpoint);
    assert.equal(rows[1].available_at.getTime(), retryAt.getTime());
    assert.equal(rows[1].requested_at.getTime(), now - 10 * 60_000);
    assert.equal(rows[1].last_error, 'Budget deferred');
    assert.equal(rows[0].state_json.pages, 346);
  });
});

test('Postgres least-worked lanes remain fair with one request per turn and honor durable provider retries', postgres, async () => {
  await withRosterDatabase('fairness', async client => {
    let clock = now;
    for (const [date, background] of [[day, true], ['2026-10-21', true], ['2026-10-20', false]]) {
      await client.query(`insert into financials_day_rankings (day, background, available_at, requested_at)
        values ($1, $2, $3, $3)`, [date, background, new Date(clock)]);
    }
    let calls = 0;
    const options = { now: () => clock, maxRequests: 1, getJson: async route => { calls++; assert.equal(route, '/health'); return health; } };
    for (let i = 0; i < 3; i++) { await detail.refreshFinancialDayQueue(client, options); clock += 5000; }
    assert.equal(calls, 3);
    const rows = (await client.query("select day::text, state_json->>'phase' as phase, last_worked_at from financials_day_rankings")).rows;
    assert.ok(rows.every(row => row.phase === 'earnings' && row.last_worked_at));
    // The global provider budget is shared, so a budget rejection ends this
    // batch rather than spending its remaining steps retrying other lanes.
    const retryAt = new Date(clock + 6 * 3600_000).toISOString();
    const before = (await client.query('select day::text, state_json, payload_json from financials_day_rankings order by last_worked_at')).rows[0];
    await detail.refreshFinancialDayQueue(client, { now: () => clock, maxRequests: 10, getJson: async () => {
      calls++; throw Object.assign(new Error('Bulk budget deferred'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt });
    } });
    assert.equal(calls, 4);
    const deferred = (await client.query('select state_json, payload_json, available_at from financials_day_rankings where day = $1', [before.day])).rows[0];
    assert.deepEqual(deferred.state_json, before.state_json); assert.deepEqual(deferred.payload_json, before.payload_json);
    assert.equal(deferred.available_at.toISOString(), retryAt);
  });
});

test('Postgres unchanged managed watermark costs one health request per quarter-hour schedule', postgres, async () => {
  await withRosterDatabase('watermark', async client => {
    const payload = { through: new Date((from + 12 * 3600) * 1000).toISOString(),
      observedAt: new Date(now - 60_000).toISOString(), swaps: [], pools: [], partial: true, finalized: false };
    await client.query(`insert into financials_day_rankings (day, background, payload_json, available_at)
      values ($1, true, $2, $3)`, [day, payload, new Date(now)]);
    let calls = 0;
    const options = { now: () => now, getJson: async route => { calls++; assert.equal(route, '/health'); return health; } };
    await detail.refreshFinancialDayQueue(client, options);
    await detail.refreshFinancialDayQueue(client, { ...options, now: () => now + 5000 });
    await detail.refreshFinancialDayQueue(client, { ...options, now: () => now + 60_000 });
    assert.equal(calls, 1);
    const saved = (await client.query('select payload_json, available_at from financials_day_rankings where day = $1', [day])).rows[0];
    assert.equal(saved.payload_json.through, payload.through);
    assert.equal(saved.payload_json.observedAt, payload.observedAt);
    assert.equal(saved.available_at.getTime(), (from + 12 * 3600 + 18 * 60) * 1000);
  });
});

test('Postgres a multi-lane catch-up batch cannot exceed ten acquisition steps', postgres, async () => {
  await withRosterDatabase('cap', async client => {
    for (const [date, background] of [[day, true], ['2026-10-21', true], ['2026-10-20', true], ['2026-10-19', false]]) {
      const start = Date.parse(`${date}T00:00:00Z`) / 1000;
      const state = { day: date, from: start, to: start + 86400, through: start + 900, phase: 'actions',
        pools: [], poolRows: [], swaps: [], tokens: [], pages: 0, pending: 0, unpriced: 0 };
      await client.query(`insert into financials_day_rankings (day, background, state_json, available_at, requested_at)
        values ($1, $2, $3, $4, $4)`, [date, background, state, new Date(now)]);
    }
    let calls = 0;
    const tokens = new Map();
    const getJson = async route => {
      calls++;
      const params = new URL(route, 'https://example.test').searchParams;
      const through = params.has('timestamp') ? Number(params.get('timestamp')) : tokens.get(params.get('nextPageToken'));
      assert.ok(through);
      tokens.set(`page-${calls}`, through);
      return { actions: [{ type: 'swap', status: 'pending', date: String(BigInt(through - 1) * 1000000000n),
        in: [{ txID: `tx-${calls}` }] }], meta: { nextPageToken: `page-${calls}` } };
    };
    await detail.refreshFinancialDayQueue(client, { now: () => now, maxRequests: 100, getJson });
    assert.equal(calls, 10);
    let rows = (await client.query("select day::text, (state_json->>'pages')::int as pages from financials_day_rankings order by day")).rows;
    assert.equal(rows.reduce((sum, row) => sum + row.pages, 0), 10);
    assert.ok(rows.find(row => row.day === day).pages >= 3);
    assert.ok(rows.find(row => row.day === '2026-10-19').pages >= 3);
    assert.equal(rows.find(row => row.day === '2026-10-21').pages, 0);
    await detail.refreshFinancialDayQueue(client, { now: () => now + 5000, maxRequests: 1, getJson });
    rows = (await client.query("select day::text, (state_json->>'pages')::int as pages from financials_day_rankings order by day")).rows;
    assert.equal(rows.find(row => row.day === '2026-10-21').pages, 1, 'the previously waiting closing day leads the next batch');
    assert.equal(calls, 11);
  });
});
