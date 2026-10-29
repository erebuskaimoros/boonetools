import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readFinancialDay, refreshFinancialDayQueue } from '../src/shared/financials-day-detail.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const postgres = { skip: !databaseUrl };
const day = '2026-10-29', timeZone = 'America/New_York';
const from = Date.parse(`${day}T04:00:00Z`) / 1000, to = from + 86400;
const now = Date.parse('2026-10-31T12:00:00Z');
const iso = seconds => new Date(seconds * 1000).toISOString();

async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `financials_local_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query("set local time zone 'Pacific/Honolulu'");
    for (const migration of ['051_pool_analysis.sql', '066_pool_analysis_intraday_snapshots.sql',
      '068_financials_day_details.sql', '072_financials_background_rosters.sql', '073_financials_swap_candidates.sql',
      '075_financials_local_fee_rankings.sql', '076_financials_fee_candidates.sql', '077_financials_pool_swap_fees.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim, '').replaceAll('public.', ''));
    }
    await client.query("update financials_swap_ledger set fee_started_at = '2099-01-01T00:00:00Z'");
    await run(client);
  } finally { await client.query('rollback'); await client.end(); }
}

test('local fee-cache migration preserves legacy rankings and isolates the same calendar date in two zones', postgres, async () => {
  await withDatabase(async client => {
    const old = { swaps: [{ txId: 'OLD-VOLUME-TOP-TEN', volumeUsd: 1e9 }], marker: 'unchanged' };
    await client.query('insert into financials_day_details(day,payload_json) values ($1,$2)', [day, old]);
    const first = await readFinancialDay(day, { client, now: () => now, timeZone });
    assert.equal(first.loading, true);
    assert.equal(first.swaps, undefined, 'old volume winners must not masquerade as fee winners');
    assert.equal(first.windowFrom, iso(from)); assert.equal(first.windowTo, iso(to));
    const payload = { day, timeZone, windowFrom: iso(from), windowTo: iso(to), through: iso(to),
      swapRankingBasis: 'liquidity-fees-usd', swaps: [], pools: [{ asset: 'BTC.BTC', volumeUsd: 42, volumeRune: 43 }],
      pendingSwaps: 0, unpricedSwaps: 0, exclusionsIncomplete: false, excludedSwaps: [] };
    await client.query('update financials_day_rankings set payload_json=$3 where day=$1 and time_zone=$2', [day, timeZone, payload]);
    await readFinancialDay(day, { client, now: () => now, timeZone: 'UTC' });
    const rows = (await client.query('select day::text,time_zone,window_start,window_end from financials_day_rankings order by time_zone')).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].window_start.toISOString(), iso(from));
    assert.equal(rows[1].window_start.toISOString(), `${day}T00:00:00.000Z`);
    const reread = await readFinancialDay(day, { client, now: () => now, timeZone });
    assert.deepEqual(reread.pools, payload.pools);
    assert.deepEqual((await client.query('select payload_json from financials_day_details where day=$1', [day])).rows[0].payload_json, old);
  });
});

test('local queue resumes the exact local window and publishes fees after complete acquisition', postgres, async () => {
  await withDatabase(async client => {
    await readFinancialDay(day, { client, now: () => now, timeZone });
    await client.query('update financials_day_rankings set requested_at=$1,available_at=$1', [new Date(now)]);
    await client.query("insert into financials_day_rankings(day,background,available_at) values ('2026-10-31',true,$1)", [new Date(now + 86400_000)]);
    const routes = [];
    const getJson = async route => {
      routes.push(route);
      if (route === '/health') return { inSync: true, lastAggregated: { timestamp: to } };
      const params = new URL(route, 'https://example.test').searchParams;
      if (route.startsWith('/actions')) {
        assert.equal(params.get('timestamp'), String(to));
        const action = (id, at, fee) => ({ type: 'swap', status: 'success', date: String(BigInt(at) * 1000000000n),
          in: [{ txID: id, coins: [{ asset: 'THOR.RUNE', amount: '10000000000' }] }],
          out: [{ coins: [{ asset: 'BTC.BTC', amount: '1000000' }] }], pools: ['BTC.BTC'],
          metadata: { swap: { inPriceUSD: '1', liquidityFee: String(fee * 1e8) } } });
        return { actions: [action('LOCAL-EVENING', to - 1, 20), action('LOCAL-MIDNIGHT', from, 10), action('PREVIOUS', from - 1, 100)] };
      }
      assert.equal(params.get('interval'), '5min'); assert.equal(params.get('from'), String(from));
      return { intervals: [{ startTime: from, endTime: to, pools: [{ pool: 'BTC.BTC' }], runePriceUSD: '1', totalVolumeUSD: '12300', totalVolume: '456000000' }] };
    };
    await refreshFinancialDayQueue(client, { now: () => now, maxRequests: 1, getJson });
    let saved = (await client.query('select state_json from financials_day_rankings where day=$1 and time_zone=$2', [day, timeZone])).rows[0].state_json;
    assert.equal(saved.phase, 'earnings'); assert.equal(saved.from, from); assert.equal(saved.to, to);
    await refreshFinancialDayQueue(client, { now: () => now, maxRequests: 10, getJson });
    const result = await readFinancialDay(day, { client, now: () => now, timeZone });
    assert.equal(result.loading, false); assert.equal(result.partial, false);
    assert.deepEqual(result.swaps.map(row => row.txId), ['LOCAL-EVENING', 'LOCAL-MIDNIGHT']);
    assert.deepEqual(result.swaps.map(row => row.feeUsd), [20, 10]);
    assert.equal(result.pools[0].volumeUsd, 123);
    assert.deepEqual(routes.map(route => route.split('?')[0]), ['/health', '/history/earnings', '/actions', '/history/swaps']);
  });
});
