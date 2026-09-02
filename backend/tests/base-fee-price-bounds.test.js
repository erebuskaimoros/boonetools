import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

// Run with ACQUISITION_TEST_DATABASE_URL pointing at the migrated disposable
// acquisition database. Every fixture lives in connection-local temporary tables.
const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
if (databaseUrl) {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  assert.match(name, /^(?:boonetools_)?acquisition_test(?:_|$)/,
    'Pricing integration checks require an explicitly selected disposable database');
}
process.env.DATABASE_URL ||= 'postgresql://localhost/unused';
const { refreshRujiraBaseFeePrices } = await import('../src/shared/rujira-base-fees.js');

async function fixture(t) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  await db.query("set timezone = 'America/New_York'");
  await db.query('create temporary table rujira_base_fee_events (like public.rujira_base_fee_events including all)');
  await db.query('create temporary table rujira_base_fee_rune_price_weeks (like public.rujira_base_fee_rune_price_weeks including all)');
  await db.query(`insert into rujira_base_fee_rune_price_weeks
    (week_start, week_end, rune_price_usd, fetched_at)
    values ('2026-07-27', '2026-08-03', 2, '2026-08-04T00:00:00Z'),
           ('2026-08-03', '2026-08-10', 3, '2026-08-11T00:00:00Z')`);
  const queries = [];
  const calls = [];
  const client = { query: async (sql, values) => {
    queries.push(sql);
    return db.query(sql, values);
  } };
  const options = { now: '2026-09-02T12:00:00Z', loadPrices: async (_client, starts, settings) => {
    calls.push({ starts, interval: settings.interval });
    // There are no newly acquired rows. Pricing must still join the existing
    // matching weekly observation rather than discard or substitute it.
    return { rows: [], requests: 0, pending_buckets: 0, errors: [] };
  } };
  const add = (key, time, { included = true, price = 0, source = 'legacy' } = {}) => db.query(
    `insert into rujira_base_fee_events
       (event_key, canonical_key, height, block_time, liquidity_fee_rune,
        rune_price_usd, liquidity_fee_usd, included, source, updated_at)
     values ($1, $1, 1, $2, 10, $3::double precision, $3::double precision * 10, $4, $5, '2026-08-12T00:00:00Z')`,
    [key, time, price, included, source]);
  const rows = async () => Object.fromEntries((await db.query(`select event_key,
    rune_price_usd, liquidity_fee_usd, updated_at from rujira_base_fee_events order by event_key`))
    .rows.map(row => [row.event_key, { price: row.rune_price_usd, usd: row.liquidity_fee_usd, updated: row.updated_at.toISOString() }]));
  const updates = () => queries.filter(sql => /^\s*update\s+rujira_base_fee_events\b/i.test(sql));
  return { db, client, options, calls, queries, updates, add, rows };
}

integration('fully priced historical weeks skip acquisition and event updates', async t => {
  const f = await fixture(t);
  await f.add('already-priced', '2026-07-28T12:00:00Z', { price: 2 });
  await f.add('dune-unpriced', '2026-08-04T12:00:00Z', { source: 'dune' });
  const before = await f.rows();
  const result = await refreshRujiraBaseFeePrices(f.client, f.options);
  assert.deepEqual(f.calls, [], 'No unpriced legacy rows means no weekly cache/acquisition sweep');
  assert.equal(f.updates().length, 0, 'No unpriced rows means no all-history UPDATE attempt');
  assert.equal(result.priced_events, 0);
  assert.deepEqual(await f.rows(), before);
});

integration('late unpriced rows use their stored UTC week without repricing history or other weeks', async t => {
  const f = await fixture(t);
  await f.add('already-valued', '2026-07-28T12:00:00Z', { price: 1.25 });
  // Midnight Monday UTC is Sunday in the database session timezone.
  await f.add('late-included', '2026-08-03T00:00:00Z');
  await f.add('late-excluded', '2026-08-03T00:05:00Z', { included: false });
  await f.add('other-week-excluded', '2026-07-28T12:00:00Z', { included: false });
  await f.add('dune-unpriced', '2026-08-04T12:00:00Z', { source: 'dune' });
  const before = await f.rows();
  const result = await refreshRujiraBaseFeePrices(f.client, f.options);
  const after = await f.rows();
  assert.equal(after['late-included'].price, 3);
  assert.equal(after['late-included'].usd, 30);
  assert.equal(after['late-excluded'].price, 3, 'Preserve pricing of excluded rows in an actively needed week');
  assert.deepEqual(after['already-valued'], before['already-valued'], 'A prior nonzero valuation must remain unchanged');
  assert.deepEqual(after['other-week-excluded'], before['other-week-excluded'], 'Unrelated weeks must not be visited by the UPDATE');
  assert.deepEqual(after['dune-unpriced'], before['dune-unpriced'], 'Dune valuations are source-owned');
  assert.deepEqual(f.calls, [{ starts: ['2026-08-03'], interval: 'week' }]);
  assert.equal(result.priced_events, 2);
  f.calls.length = 0;
  f.queries.length = 0;
  const next = await refreshRujiraBaseFeePrices(f.client, f.options);
  assert.deepEqual(f.calls, []);
  assert.equal(f.updates().length, 0);
  assert.equal(next.priced_events, 0);
  assert.deepEqual(await f.rows(), after);
});

integration('excluded rows alone do not schedule weekly price acquisition', async t => {
  const f = await fixture(t);
  await f.add('excluded-only', '2026-08-04T12:00:00Z', { included: false });
  const before = await f.rows();
  await refreshRujiraBaseFeePrices(f.client, f.options);
  assert.deepEqual(f.calls, []);
  assert.equal(f.updates().length, 0);
  assert.deepEqual(await f.rows(), before);
});
