import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { parseFinancialPoolSwapFees, verifyFinancialSwapCandidates } from '../src/shared/financials-swap-candidates.js';
import { parseFinancialRevshareBlock, saveFinancialRewardBlocks } from '../src/shared/financials-reward-source.js';
import { readFinancialPoolSwapDay } from '../src/shared/financials-pool-swaps.js';
import { handlePoolAnalysisSwaps } from '../src/handlers/pool-analysis.js';

const event = (id, pool, fee, count = 1, quantity = 1) => ({ type: 'swap', attributes: Object.entries({
  id, pool, coin: '100000000000 THOR.RUNE', emit_asset: `100000000 ${pool}`,
  liquidity_fee_in_rune: String(fee), streaming_swap_count: String(count), streaming_swap_quantity: String(quantity)
}).map(([key,value]) => ({key,value})) });
const block = (height, time, events = []) => ({ ...parseFinancialRevshareBlock({ result: { height,
  finalize_block_events: events } }, height), blockTime: time });
const action = (txId, fee = '100000000') => ({ type: 'swap', status: 'success', date: '1793260860000000000',
  in: [{txID:txId,coins:[{asset:'THOR.RUNE',amount:'100000000000'}]}],
  out: [{coins:[{asset:'ZEC.ZEC',amount:'100000000'}]}],
  metadata:{swap:{inPriceUSD:'0.5',liquidityFee:fee}} });

test('pool fee parsing keeps both route legs separate and sums streaming legs without inferring a missing pool', () => {
  const events = [event('route','BTC.BTC',100),event('route','ZEC.ZEC',200),event('route','ZEC.ZEC',300)];
  const parsed = parseFinancialPoolSwapFees(events);
  assert.deepEqual(parsed, {complete:true,fees:[
    {txId:'ROUTE',asset:'BTC.BTC',feeRuneE8:'100'}, {txId:'ROUTE',asset:'ZEC.ZEC',feeRuneE8:'500'}]});
  const encoded = events.map(item => ({type:Buffer.from(item.type).toString('base64'),attributes:item.attributes.map(({key,value})=>({
    key:Buffer.from(key).toString('base64'),value:Buffer.from(value).toString('base64')}))}));
  assert.deepEqual(parseFinancialPoolSwapFees(encoded), parsed);
  assert.equal(parseFinancialPoolSwapFees([event('bad','',100)]).complete, false);
  assert.equal(parseFinancialPoolSwapFees([event('bad','BTC.BTC','invalid')]).complete, false);
  assert.deepEqual(parseFinancialPoolSwapFees([event('zero','BTC.BTC',0)]).fees[0].feeRuneE8, '0');
});

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const postgres = {skip:!databaseUrl};
async function database(run) {
  assert.match(new URL(databaseUrl).pathname,/^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `pool_swaps_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({connectionString:databaseUrl});
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query("set local time zone 'Pacific/Honolulu'");
    for (const migration of ['043_chain_block_headers.sql','051_pool_analysis.sql','054_system_income_pol.sql',
      '066_pool_analysis_intraday_snapshots.sql','067_financials_reward_accounting.sql','068_financials_day_details.sql',
      '072_financials_background_rosters.sql','073_financials_swap_candidates.sql','075_financials_local_fee_rankings.sql',
      '076_financials_fee_candidates.sql','077_financials_pool_swap_fees.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim,'').replaceAll('public.',''));
    }
    await client.query("update financials_swap_ledger set fee_started_at='2026-10-28T00:00:00Z',pool_started_at='2026-10-29T08:00:00Z'");
    await client.query("insert into pool_analysis_daily(asset,day,rune_price_usd) values ('BTC.BTC','2026-10-29',0.5),('BTC.BTC','2026-10-30',0.5)");
    await run(client);
  } finally {await client.query('rollback');await client.end();}
}
async function save(client, blocks) {
  await saveFinancialRewardBlocks(client,blocks);
  for (const item of blocks) await client.query(`insert into system_income_pol_blocks(height,block_time,source)
    values($1,$2,'test') on conflict do nothing`,[item.height,item.blockTime]);
}
const now = Date.parse('2026-10-29T08:10:00Z');

test('capture starts at rollout, persists both pool legs once, and discloses the partial first local day',postgres,async()=>database(async client=>{
  const blocks=[block(1,'2026-10-29T07:59:59Z',[event('old','ZEC.ZEC',9000000000)]),
    block(2,'2026-10-29T08:01:00Z',[event('route','BTC.BTC',100000000),event('route','ZEC.ZEC',300000000)]),
    block(3,'2026-10-29T08:10:00Z')];
  await save(client,blocks);await save(client,[...blocks].reverse());
  assert.deepEqual((await client.query('select asset,fee_rune_e8::text from financials_swap_pool_fees order by asset')).rows,
    [{asset:'BTC.BTC',fee_rune_e8:'100000000'},{asset:'ZEC.ZEC',fee_rune_e8:'300000000'}]);
  assert.equal((await client.query('select count(*)::int as n from financials_pool_swap_blocks')).rows[0].n,2);
  await verifyFinancialSwapCandidates(client,{poolScopes:true,now:()=>now,getJson:async()=>({actions:[action('ROUTE','400000000')]})});
  const detail=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-29',{timeZone:'America/New_York',now});
  assert.equal(detail.windowFrom,'2026-10-29T04:00:00.000Z');
  assert.equal(detail.partialCoverage,true);assert.equal(detail.coverageComplete,true);
  assert.equal(detail.swaps[0].feeUsd,1.5);assert.equal(detail.swaps[0].feeRune,3);
  const btc=await readFinancialPoolSwapDay(client,'BTC.BTC','2026-10-29',{timeZone:'America/New_York',now});
  assert.equal(btc.swaps[0].feeUsd,.5);
  const old=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-28',{now});
  assert.equal(old.availability,'before-tracking');assert.deepEqual(old.swaps,[]);
  assert.equal((await client.query("select count(*)::int as n from financials_pool_swap_windows where day='2026-10-28'")).rows[0].n,0);
}));

test('a pool leader outside the global top 25 is checked within the same bounded request budget',postgres,async()=>database(async client=>{
  const events=Array.from({length:30},(_,i)=>event(`big-${i}`,'BTC.BTC',10000000000+i));
  await save(client,[block(10,'2026-10-29T08:01:00Z',[...events,event('small-pool-leader','ZEC.ZEC',100000000)])]);
  await client.query("update financials_swap_candidates set status='verified',verified_row=jsonb_build_object('feeRune',100) where tx_id like 'BIG-%'");
  const calls=[];
  await verifyFinancialSwapCandidates(client,{poolScopes:true,now:()=>now,maxRequests:1,getJson:async route=>{
    const id=new URL(route,'https://test.invalid').searchParams.get('txid');calls.push(id);return {actions:[action(id)]};
  }});
  assert.deepEqual(calls,['SMALL-POOL-LEADER']);
  const detail=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-29',{now});
  assert.deepEqual(detail.swaps.map(row=>row.txId),['SMALL-POOL-LEADER']);
}));

test('top ten sort by pool fees rather than route fees or input notional, and exclude a prior local-day start',postgres,async()=>database(async client=>{
  await client.query("update financials_swap_ledger set pool_started_at='2026-10-29T00:00:00Z'");
  await save(client,[block(1,'2026-10-29T03:59:59Z',[event('prior-local-day','ZEC.ZEC',99900000000)]),
    block(2,'2026-10-29T08:01:00Z',Array.from({length:12},(_,i)=>event(`rank-${String(i).padStart(2,'0')}`,'ZEC.ZEC',(i+1)*100000000)))]);
  await client.query(`update financials_swap_candidates set status='verified',verified_row=jsonb_build_object(
    'feeRune',10000-fee_rune_e8/1e8,'volumeUsd',100000-fee_rune_e8/1e8,'inputAsset','THOR.RUNE','outputAsset','ZEC.ZEC')`);
  const detail=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-29',{timeZone:'America/New_York',now});
  assert.deepEqual(detail.swaps.map(row=>row.txId),Array.from({length:10},(_,i)=>`RANK-${String(11-i).padStart(2,'0')}`));
  assert.deepEqual(detail.swaps.map(row=>row.feeUsd),[6,5.5,5,4.5,4,3.5,3,2.5,2,1.5]);
  assert.equal(detail.swaps[0].feeRate,6/(100000-12));
  await client.query('delete from pool_analysis_daily');
  const unpriced=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-29',{timeZone:'America/New_York',now});
  assert.deepEqual(unpriced.swaps,[]);assert.equal(unpriced.unpricedSwaps,12);
}));

test('late stream completion accumulates only its pool fees and keeps the original local start day',postgres,async()=>database(async client=>{
  const blocks=[block(10,'2026-10-30T03:59:00Z',[event('stream','ZEC.ZEC',100000000,1,3)]),
    block(11,'2026-10-30T04:00:00Z',[event('stream','ZEC.ZEC',200000000,2,3)]),
    block(12,'2026-10-30T04:01:00Z',[event('stream','ZEC.ZEC',300000000,3,3),{type:'streaming_swap',attributes:
      Object.entries({tx_id:'stream',deposit:'300000000000 THOR.RUNE',out:'300000000 ZEC.ZEC'}).map(([key,value])=>({key,value}))}])];
  await save(client,[...blocks].reverse());await save(client,blocks);
  const lateNow=Date.parse('2026-10-30T04:10:00Z');
  await verifyFinancialSwapCandidates(client,{poolScopes:true,now:()=>lateNow,getJson:async()=>({actions:[action('STREAM','600000000')]})});
  const before=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-29',{timeZone:'America/New_York',now:lateNow});
  const after=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-30',{timeZone:'America/New_York',now:lateNow});
  assert.equal(before.swaps[0].feeUsd,3);assert.deepEqual(after.swaps,[]);
}));

test('missing or unattributed blocks stay explicit and unverified zero-fee swaps stay pending',postgres,async()=>database(async client=>{
  await save(client,[block(1,'2026-10-29T07:59:59Z'),block(2,'2026-10-29T08:01:00Z',[event('zero','ZEC.ZEC',0)]),
    block(4,'2026-10-29T08:10:00Z',[event('bad','',100)])]);
  const detail=await readFinancialPoolSwapDay(client,'ZEC.ZEC','2026-10-29',{now});
  assert.equal(detail.missingBlocks,1);assert.equal(detail.unattributedBlocks,1);
  assert.equal(detail.coverageComplete,false);assert.equal(detail.pendingSwaps,1);assert.deepEqual(detail.swaps,[]);
}));

test('a budget-deferred pool leader remains eligible after the recent-day horizon without scanning history',postgres,async()=>database(async client=>{
  await save(client,[block(10,'2026-10-29T08:01:00Z',[event('late','ZEC.ZEC',100000000)])]);
  await verifyFinancialSwapCandidates(client,{poolScopes:true,now:()=>now,getJson:async()=>{
    throw Object.assign(new Error('budget'),{code:'MIDGARD_BUDGET_DEFERRED',skipProvider:true});
  }});
  let calls=0;
  await verifyFinancialSwapCandidates(client,{poolScopes:true,now:()=>Date.parse('2026-11-04T00:00:00Z'),getJson:async route=>{
    assert.match(route,/^\/actions\?txid=LATE&limit=50$/);calls++;return {actions:[action('LATE')]};
  }});
  assert.equal(calls,1);
  assert.equal((await client.query("select status from financials_swap_candidates where tx_id='LATE'")).rows[0].status,'verified');
}));

test('pool endpoint validates dates/timezones/assets before reading and forwards the canonical local window',async()=>{
  const calls=[];const options={now:()=>now,getReadModel:async()=>({payload:{pools:[{asset:'ZEC.ZEC'}]}}),
    readDay:async(...args)=>{calls.push(args);return {swaps:[]};}};
  const request=query=>handlePoolAnalysisSwaps(null,new URL(`https://test.invalid/pool-analysis-swaps?${query}`),options);
  for (const query of ['asset=ZEC.ZEC&day=2026-02-30','asset=ZEC.ZEC&day=2026-10-29&timeZone=Invalid/Zone','asset=bad&day=2026-10-29']) {
    assert.equal((await request(query)).status,400);
  }
  assert.equal(calls.length,0);
  assert.equal((await request('asset=ETH.ETH&day=2026-10-29')).status,404);
  const response=await request('asset=zec.zec&day=2026-10-29&timeZone=US/Eastern');
  assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'no-store');
  assert.deepEqual(calls,[['ZEC.ZEC','2026-10-29',{now,timeZone:'America/New_York'}]]);
});
