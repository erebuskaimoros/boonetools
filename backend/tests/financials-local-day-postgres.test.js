import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readFinancialDay, refreshFinancialDayQueue, financialDetailDay } from '../src/shared/financials-day-detail.js';

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
      '075_financials_local_fee_rankings.sql', '076_financials_fee_candidates.sql', '077_financials_pool_swap_fees.sql', '078_financials_verification_pause.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim, '').replaceAll('public.', ''));
    }
    await client.query('alter table pool_analysis_daily add column completed_at timestamptz');
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

test('a paused swap scan cannot freeze local-day pool rankings at its old cutoff', postgres, async () => {
  await withDatabase(async client => {
    const currentNow = Date.parse('2026-10-29T21:32:00Z');
    const oldThrough = '2026-10-29T07:45:00.000Z', poolThrough = '2026-10-29T21:30:00.000Z';
    const payload = { day, timeZone, windowFrom: iso(from), windowTo: iso(to), through: oldThrough,
      swapRankingBasis: 'liquidity-fees-usd', swaps: [{txId:'SAVED-SWAP',feeUsd:100}],
      pools: [{asset:'ETH.ETH',volumeUsd:331320.62,volumeRune:539865.32790366}], partial:true };
    await readFinancialDay(day,{client,now:()=>currentNow,timeZone});
    await client.query(`update financials_day_rankings set payload_json=$3,state_json='{"phase":"actions","pages":123}',
      last_error='Midgard request deferred by shared budget (bulk-day)', available_at='2026-10-30T00:00:00Z'
      where day=$1 and time_zone=$2`,[day,timeZone,payload]);
    for (const [asset,startRune,startUsd,endRune,endUsd] of [
      ['ETH.ETH','65140721577099','40153502','563292488090707','346680484'],
      ['BTC.BTC','329169981682320','206465787','641806511600449','398567931'],
      ['TRON.USDT','18777478956836','11644721','329947493542650','202926753']
    ]) {
      await client.query('insert into pool_analysis_sync_state(asset) values($1)',[asset]);
      await client.query(`insert into pool_analysis_intraday_snapshots(asset,bucket_end,volume_rune_e8,volume_usd_e2,fees_rune_e8,observed_at)
        values($1,$2,$3,$4,0,$7),($1,$5,$6,$8,0,$7)`,[asset,iso(from),startRune,startUsd,poolThrough,endRune,new Date(currentNow),endUsd]);
    }
    const result=await readFinancialDay(day,{client,now:()=>currentNow,timeZone});
    assert.deepEqual(result.pools.map(row=>[row.asset,row.volumeUsd]),[
      ['ETH.ETH',3065269.82],['BTC.BTC',1921021.44],['TRON.USDT',1912820.32]
    ]);
    assert.equal(result.poolRanking.through,poolThrough);
    assert.equal(result.poolRanking.from,iso(from));
    assert.equal(result.poolRanking.complete,true);
    assert.equal(result.through,oldThrough,'swap cutoff must not be advanced to the independently refreshed pool cutoff');
    assert.equal(result.deferred,true);
    assert.deepEqual(result.swaps,payload.swaps);
    assert.equal(result.progress.pages,123);
    const saved=(await client.query('select payload_json,last_error from financials_day_rankings where day=$1 and time_zone=$2',[day,timeZone])).rows[0];
    assert.deepEqual(saved.payload_json,payload,'cached swap state must be preserved');
    assert.match(saved.last_error,/bulk-day/);
  });
});


async function prefix(client, asset, at, cents) {
  await client.query(`insert into pool_analysis_intraday_snapshots
    (asset,bucket_end,volume_rune_e8,volume_usd_e2,fees_rune_e8) values($1,$2,$3,$3,0)`,[asset,at,cents]);
}
async function tracked(client, assets) {
  await client.query('insert into pool_analysis_sync_state(asset) select unnest($1::text[])',[assets]);
}
async function sealedDay(client, asset, date, cents) {
  await client.query(`insert into pool_analysis_daily(asset,day,volume_rune_e8,volume_usd_e2,
    interval_start,interval_end,partial,source,completed_at) values($1,$2,$3,$3,
    $2::date::timestamp at time zone 'UTC',($2::date+1)::timestamp at time zone 'UTC',false,'liquify-midgard-swaps',now())`,[asset,date,cents]);
}

test('cold local-day reads rank pools at one cutoff and disclose missing or invalid boundaries without mixing older totals', postgres, async()=>{
  await withDatabase(async client=>{
    const currentNow=Date.parse('2026-10-29T21:32:00Z');
    await tracked(client,['BTC.BTC','ETH.ETH','ZEC.ZEC']);
    for (const asset of ['BTC.BTC','ETH.ETH','ZEC.ZEC']) await prefix(client,asset,iso(from),100);
    await prefix(client,'BTC.BTC','2026-10-29T21:30:00Z',1000);
    await prefix(client,'BTC.BTC','2026-10-29T22:00:00Z',999999);
    await prefix(client,'ETH.ETH','2026-10-29T21:15:00Z',2000);
    await prefix(client,'ZEC.ZEC','2026-10-29T21:30:00Z',50);
    const detail=await readFinancialDay(day,{client,timeZone,now:()=>currentNow});
    assert.equal(detail.loading,true,'pool reads do not wait for a first swap snapshot');
    assert.deepEqual(detail.pools.map(row=>[row.asset,row.volumeUsd]),[['BTC.BTC',9]]);
    assert.equal(detail.poolRanking.through,'2026-10-29T21:30:00.000Z');
    assert.equal(detail.poolRanking.complete,false);
    assert.deepEqual(detail.poolRanking.missingPools,['ETH.ETH','ZEC.ZEC']);
    assert.equal(detail.poolRanking.fallback,false);
    assert.equal(detail.poolRanking.stale,false);
  });
});

test('closed local-day pools honor both DST lengths using exact prefixes and sealed UTC totals', postgres, async()=>{
  await withDatabase(async client=>{
    await tracked(client,['BTC.BTC']);
    for (const [date,expectedHours] of [['2026-03-08',23],['2026-11-01',25]]) {
      const currentNow=Date.parse(date+'T00:00:00Z')+3*86400000;
      const window=financialDetailDay(date,currentNow,timeZone);
      assert.equal((window.to-window.from)/3600,expectedHours);
      await prefix(client,'BTC.BTC',iso(window.from),1000);
      await sealedDay(client,'BTC.BTC',date,3000);
      await prefix(client,'BTC.BTC',iso(window.to),500);
      const detail=await readFinancialDay(date,{client,timeZone,now:()=>currentNow});
      assert.equal(detail.pools[0].volumeUsd,25);
      assert.equal(detail.poolRanking.from,iso(window.from));
      assert.equal(detail.poolRanking.through,iso(window.to));
      assert.equal(detail.poolRanking.complete,true);
      assert.equal(detail.poolRanking.stale,false);
    }
  });
});

test('an open local day after UTC rollover sums its sealed first slice and current prefix',postgres,async()=>{
  await withDatabase(async client=>{
    await tracked(client,['BTC.BTC']);
    await prefix(client,'BTC.BTC',iso(from),100);
    await sealedDay(client,'BTC.BTC',day,1000);
    await prefix(client,'BTC.BTC','2026-10-30T02:15:00Z',300);
    const detail=await readFinancialDay(day,{client,timeZone,now:()=>Date.parse('2026-10-30T02:17:00Z')});
    assert.equal(detail.pools[0].volumeUsd,12);
    assert.equal(detail.poolRanking.through,'2026-10-30T02:15:00.000Z');
    assert.equal(detail.poolRanking.complete,true);
  });
});

test('unavailable exact local windows retain the whole saved ranking with its real older cutoff',postgres,async()=>{
  await withDatabase(async client=>{
    const currentNow=Date.parse('2026-10-29T21:32:00Z');
    const payload={day,timeZone,windowFrom:iso(from),windowTo:iso(to),through:'2026-10-29T07:45:00.000Z',
      swaps:[],pools:[{asset:'BTC.BTC',volumeUsd:123,volumeRune:200}]};
    await readFinancialDay(day,{client,timeZone,now:()=>currentNow});
    await client.query('update financials_day_rankings set payload_json=$3 where day=$1 and time_zone=$2',[day,timeZone,payload]);
    await tracked(client,['BTC.BTC']);
    await prefix(client,'BTC.BTC','2026-10-29T21:30:00Z',999999);
    const detail=await readFinancialDay(day,{client,timeZone,now:()=>currentNow});
    assert.deepEqual(detail.pools,payload.pools);
    assert.equal(detail.poolRanking.through,payload.through);
    assert.equal(detail.poolRanking.fallback,true);
    assert.equal(detail.poolRanking.stale,true);
    assert.equal(detail.poolRanking.source,'saved-ranking');
  });
});
