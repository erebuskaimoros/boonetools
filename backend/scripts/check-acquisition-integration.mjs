/**
 * Provider-free PostgreSQL acquisition integration checks.
 *
 * First apply every backend/migrations/*.sql file to a disposable database whose
 * name starts with acquisition_test (or boonetools_acquisition_test), then run:
 *
 * ACQUISITION_TEST_DATABASE_URL=postgresql://localhost/acquisition_test_local \
 *   node backend/scripts/check-acquisition-integration.mjs
 *
 * The named fixture tables are truncated. This script refuses ordinary database
 * names, never uses DATABASE_URL as an implicit target, and blocks network fetch.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set ACQUISITION_TEST_DATABASE_URL to a migrated disposable test database');
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/^(?:boonetools_)?acquisition_test(?:_|$)/.test(databaseName)) {
  throw new Error('Integration database name must start with acquisition_test or boonetools_acquisition_test');
}
process.env.DATABASE_URL = databaseUrl;
process.env.DUNE_API_KEY = 'integration-test-only';
process.env.RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME = '2026-04-30T00:00:00Z';
process.env.RUJIRA_RESERVE_PAYMENTS_DUNE_HEAD_LAG_HOURS = '6';
globalThis.fetch = async () => { throw new Error('External provider calls are disabled in this integration check'); };
const root = new URL('../src/shared/', import.meta.url).href;
const {loadAcquisition,saveAcquisition,acquireCached}=await import(root+'acquisition-cache.js');
const {recordCollectorEventBlock,resetCollectorEventCoverage}=await import(root+'app-layer-live-state.js');
const {upsertBurnTrackerDays,loadBurnTrackerPendingDays,loadBurnTrackerTotals}=await import(root+'burn-tracker-store.js');
const {refreshRujiraReservePaymentPrices,runRujiraReservePaymentsDuneIngestion}=await import(root+'rujira-reserve-payments.js');
const {refreshRujiraBaseFeePrices}=await import(root+'rujira-base-fees.js');
const {enqueueAffiliateHistory,refreshAffiliateRange,refreshAffiliateQueue,readAffiliateVolume}=await import(root+'dynamic-fee-affiliate-ingestion.js');
const {readVisitorSnapshot,refreshVisitorSnapshots}=await import(root+'visitor-snapshots.js');
const connection = { connectionString: databaseUrl };
const db = new pg.Client(connection);
await db.connect();
const actualDatabase = (await db.query('select current_database() as name')).rows[0].name;
assert.equal(actualDatabase, databaseName, 'Connected database must match the explicitly selected test database');
const NOW='2026-09-02T09:00:00Z';const nowMs=Date.parse(NOW);let checks=0;
function pass(label){console.log('PASS '+label);checks++;}
try{
 await db.query('truncate bond_tx_event_sync_state, source_observations, app_layer_collector_event_state, system_income_burn_daily, rujira_reserve_payment_events, rujira_reserve_payment_rune_price_days, rujira_base_fee_events, rujira_base_fee_rune_price_weeks, dynamic_fee_affiliate_sync, dynamic_fee_affiliate_days, dynamic_fee_affiliate_actions, visitor_snapshot_requests');
 const record={namespace:'integration',identity:'closed',payload:{price:2},source:'fixture',observedAt:NOW,completedAt:NOW};
 await saveAcquisition(db,record);
 await saveAcquisition(db,{...record,payload:{price:3},completedAt:null},{force:true});
 assert.equal((await loadAcquisition(db,'integration','closed')).payload.price,2);
 await saveAcquisition(db,{...record,payload:{price:4}},{force:true});
 assert.equal((await loadAcquisition(db,'integration','closed')).payload.price,4);
 const peers=[new pg.Client(connection),new pg.Client(connection)];await Promise.all(peers.map(c=>c.connect()));let loads=0;
 const opts={namespace:'integration',identity:'flight',immutable:true,load:async()=>{loads++;await new Promise(done=>setTimeout(done,15));return {valid:true};}};
 await Promise.all(peers.map(c=>acquireCached(c,opts)));assert.equal(loads,1);await Promise.all(peers.map(c=>c.end()));pass('061 completed guard, explicit repair, and cross-session singleflight');
 // Opposite acquisition order on two SQL sessions used to queue waiting locks
 // ahead of their own saves. Keep the same PostgreSQL reproduction as a gate.
 const other = new pg.Client(connection);
 await other.connect();
 await Promise.all([db, other].map(client => client.query("set statement_timeout = '3s'")));
 let entered = 0;
 let release;
 let ready;
 const gate = new Promise(done => { release = done; });
 const bothReady = new Promise(done => { ready = done; });
 const reversed = identity => ({ namespace: 'integration-lock-order', identity, immutable: true,
   load: async () => { if (++entered === 2) ready(); await gate; return { valid: true }; }
 });
 const concurrent = [acquireCached(db, reversed('A')), acquireCached(other, reversed('B'))];
 await bothReady;
 concurrent.push(acquireCached(db, reversed('B')), acquireCached(other, reversed('A')));
 await new Promise(done => setTimeout(done, 25));
 release();
 const settled = await Promise.allSettled(concurrent);
 await other.end();
 await db.query('reset statement_timeout');
 assert.ok(settled.every(result => result.status === 'fulfilled'),
   `Opposite session lock ordering must finish: ${settled.map(result => result.reason?.message || result.status).join(', ')}`);
 pass('061 opposite session acquisition ordering cannot block completed saves');
 const event=(height,dirty=false,complete=true)=>({block:{header:{height:String(height),time:NOW},data:{txs:[]}},result_finalize_block:{events:dirty?[{type:'sudo',attributes:[{key:'_contract_address',value:'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7'}]}]:[],...(complete?{tx_results:[]}:{})}});
 const state=async()=>(await db.query('select * from app_layer_collector_event_state')).rows[0];
 await recordCollectorEventBlock(db,event(100));assert.equal((await state()).contiguous_blocks,1);
 await recordCollectorEventBlock(db,event(101,true));assert.equal((await state()).contiguous_blocks,2);assert.equal((await state()).dirty_heights.trade,101);
 await recordCollectorEventBlock(db,event(103));assert.equal((await state()).generation,'2');assert.equal((await state()).contiguous_blocks,1);
 await recordCollectorEventBlock(db,event(104,false,false));assert.equal((await state()).generation,'3');assert.equal((await state()).contiguous_blocks,0);
 await recordCollectorEventBlock(db,event(102,true));assert.equal((await state()).last_height,'104');
 await resetCollectorEventCoverage(db);assert.equal((await state()).generation,'4');
 await recordCollectorEventBlock(db,event(105));await recordCollectorEventBlock(db,event(106));assert.equal((await state()).contiguous_blocks,2);pass('063 collector dirty heights, gaps, malformed coverage, duplicates, restart and recovery');
 const burn=(day,value,complete=false,price=3)=>({day,burn_e8:String(value),rune_price_usd:price,interval_start:day+'T00:00:00Z',interval_end:new Date(Date.parse(day)+86400000).toISOString(),partial:!complete,source:'fixture',source_json:{value},completed_at:complete?NOW:null});
 await upsertBurnTrackerDays(db,[burn('2026-08-30',10)]);await upsertBurnTrackerDays(db,[burn('2026-08-30',20,false,null)]);
 assert.equal((await db.query('select rune_price_usd from system_income_burn_daily')).rows[0].rune_price_usd,null);
 await upsertBurnTrackerDays(db,[burn('2026-08-30',30,true)]);
 await upsertBurnTrackerDays(db,[burn('2026-08-30',40)],{force:true});assert.equal((await db.query('select burn_e8 from system_income_burn_daily')).rows[0].burn_e8,'30');
 await upsertBurnTrackerDays(db,[burn('2026-08-30',50,true)],{force:true});
 assert.deepEqual(await loadBurnTrackerPendingDays(db,'2026-08-30','2026-09-02'),['2026-08-31','2026-09-01']);
 await upsertBurnTrackerDays(db,[burn('2026-09-02',4)]);assert.equal((await loadBurnTrackerTotals(db,'2026-08-30','2026-09-02')).complete,false);
 await upsertBurnTrackerDays(db,[burn('2026-08-31',3,true),burn('2026-09-01',2,true)]);assert.equal((await loadBurnTrackerTotals(db,'2026-08-30','2026-09-02')).complete,true);
 await db.query("insert into bond_tx_event_sync_state(bond_address,midgard_scanned_through,midgard_source_key,midgard_scan_json,dune_seeded_at) values ('integration',$1,'fixture','{}',$1)",[NOW]);pass('062 coherent Burn observations, immutable guards, pending days, complete baseline and Bond columns');
 // Republishing a raw cache hit must not restart the live field's freshness.
 const rawExpiresAt = new Date(Date.now() + 1000).toISOString();
 await readVisitorSnapshot(db, 'vault');
 await refreshVisitorSnapshots(db, { build: async kind => ({ kind, field_meta: {
   current: { fetched_at: new Date(Date.now() - 29000).toISOString(), expires_at: rawExpiresAt }
 } }) });
 const rawAgeSnapshot = await loadAcquisition(db, 'visitor-snapshot:v1', 'vault', { allowStale: true });
 assert.ok(Date.parse(rawAgeSnapshot.expiresAt) <= Date.parse(rawExpiresAt),
   'Outer snapshot expiry must not extend an already cached live source expiry');
 await db.query("delete from source_observations where namespace='visitor-snapshot:v1'");
 await db.query('truncate visitor_snapshot_requests');
 pass('064 outer visitor freshness stays bounded by raw source expiry');
 // UTC history boundaries must not inherit the database session's DST rules.
 await db.query("set timezone = 'America/New_York'");
 const dstStart = Date.parse('2026-03-07T00:00:00Z') / 1000;
 await enqueueAffiliateHistory(db, { affiliate: 'utc-dst', fromTimestamp: dstStart, toTimestamp: dstStart + 4 * 86400 });
 const dstStats = await refreshAffiliateQueue(db, { nowMs, maxPages: 4, bases: ['fixture'],
   fetchMidgard: async () => ({ database: true, inSync: true, lastAggregated: { height: 100, timestamp: nowMs / 1000 } }),
   fetchActions: async () => {
     const scan = (await db.query("select scan_from, scan_to from dynamic_fee_affiliate_sync where affiliate='utc-dst'")).rows[0];
     assert.equal(Number(scan.scan_from) % 86400, 0, 'DST must not shift a UTC scan start');
     assert.equal(Number(scan.scan_to) % 86400, 0, 'DST must not shift a UTC scan end');
     return { actions: [], meta: {} };
   }
 });
 assert.deepEqual(dstStats.errors, []);
 assert.deepEqual((await db.query("select to_char(day, 'YYYY-MM-DD') as day from dynamic_fee_affiliate_days where affiliate='utc-dst' order by day")).rows.map(row => row.day),
   ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
 await db.query("delete from dynamic_fee_affiliate_sync where affiliate='utc-dst'");
 await db.query("delete from dynamic_fee_affiliate_days where affiliate='utc-dst'");
 await db.query('reset timezone');
 pass('064 UTC day planning remains exact across a non-UTC DST transition');
 await db.query("insert into rujira_reserve_payment_events(event_key,canonical_key,height,block_time,sender,recipient,amount_rune,source) values ('integration','integration',1,'2026-08-25T01:00:00Z','thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr','thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt',10,'ws')");
 await db.query("insert into rujira_base_fee_events(event_key,canonical_key,height,block_time,liquidity_fee_rune,included,source) values ('integration','integration',1,'2026-08-25T01:00:00Z',10,true,'ws')");
 let requests=0;const priceOptions={now:NOW,healthNow:NOW,fetchMidgard:async(endpoint)=>{requests++;if(endpoint==='/health')return {database:true,inSync:true,lastAggregated:{height:100,timestamp:nowMs/1000}};const q=new URL(endpoint,'https://fixture').searchParams;return {intervals:[{startTime:Number(q.get('from')),endTime:Number(q.get('to')),runePriceUSD:'2'}]};}};
 await refreshRujiraReservePaymentPrices(db,priceOptions);await refreshRujiraBaseFeePrices(db,priceOptions);assert.equal(requests,4);
 assert.equal((await db.query('select amount_usd from rujira_reserve_payment_events')).rows[0].amount_usd,'20');assert.equal((await db.query('select liquidity_fee_usd from rujira_base_fee_events')).rows[0].liquidity_fee_usd,20);
 const updated=(await db.query('select updated_at from rujira_reserve_payment_rune_price_days')).rows[0].updated_at.toISOString();
 await refreshRujiraReservePaymentPrices(db,priceOptions);await refreshRujiraBaseFeePrices(db,priceOptions);assert.equal(requests,4);assert.equal((await db.query('select updated_at from rujira_reserve_payment_rune_price_days')).rows[0].updated_at.toISOString(),updated);pass('Reserve/BaseFee same-base completed pricing: two runs no repeated requests or timestamp writes');
 await db.query("delete from rujira_reserve_payment_sync_state where sync_key='rujira-reserve-payment-dune:v1'");
 await runRujiraReservePaymentsDuneIngestion(db,{now:NOW,executeDune:async()=>({executionId:'test',rows:[],metadata:{total_row_count:0}})});
 const progress=(await db.query("select stats_json from rujira_reserve_payment_sync_state where sync_key='rujira-reserve-payment-dune:v1'")).rows[0].stats_json;
 assert.equal(progress.covered_through,'2026-05-03T00:00:00.000Z');pass('Reserve separate verified-empty Dune coverage cursor');
 const from=Date.parse('2026-08-01T00:00:00Z')/1000;const params={affiliate:'integration',fromTimestamp:from,toTimestamp:from+86400,includeTransactions:true};
 await enqueueAffiliateHistory(db,params);await enqueueAffiliateHistory(db,{...params,toTimestamp:from+2*86400});
 assert.equal(Number((await db.query("select requested_to from dynamic_fee_affiliate_sync where affiliate='integration'")).rows[0].requested_to),from+2*86400);
 assert.equal((await readAffiliateVolume(db,params)).points.length,0);
 await db.query("update dynamic_fee_affiliate_sync set scan_from=$1,scan_to=$2,scan_watermark=$3,source_base='fixture' where affiliate='integration'",[from,from+86400,from+3*86400]);
 const sync=async()=>(await db.query("select * from dynamic_fee_affiliate_sync where affiliate='integration'")).rows[0];
 const action=(id)=>({date:String(BigInt(from+60)*1000000000n),height:'10',status:'success',in:[{txID:id,coins:[{amount:'100000000',asset:'BTC.BTC'}]}],pools:['BTC.BTC','ETH.ETH'],metadata:{swap:{inPriceUSD:'2'}}});
 const first=await refreshAffiliateRange(db,await sync(),{maxPages:1,nowMs,fetchActions:async()=>({actions:[action('abc')],meta:{prevPageToken:'next'}})});assert.equal(first.complete,false);assert.equal((await sync()).page_token,'next');
 await assert.rejects(refreshAffiliateRange(db,await sync(),{nowMs,fetchActions:async()=>{throw Error('outage')}}));assert.equal((await db.query('select count(*) from dynamic_fee_affiliate_actions')).rows[0].count,'1');
 await refreshAffiliateRange(db,await sync(),{nowMs,fetchActions:async(p)=>{assert.ok(['next','terminal'].includes(p.prevPageToken));return p.prevPageToken === 'next' ? {actions:[action('def')],meta:{prevPageToken:'terminal'}} : {actions:[],meta:{}}}});
 assert.equal((await sync()).scan_from,null);const volume=await readAffiliateVolume(db,params);assert.equal(volume.points.length,1);assert.equal(volume.routeCount,2);assert.equal(volume.coverage.days_completed,1);
 let actionRequests=0;const queue=await refreshAffiliateQueue(db,{nowMs,maxPages:2,bases:['fixture'],fetchMidgard:async()=>({database:true,inSync:true,lastAggregated:{height:100,timestamp:nowMs/1000}}),fetchActions:async(p)=>{actionRequests++;assert.equal(Number(p.fromTimestamp),from+86400-1);return {actions:[],meta:{}}}});assert.equal(queue.errors.length,0);assert.equal(actionRequests,1);
 await refreshAffiliateQueue(db,{nowMs,maxPages:2,fetchActions:async()=>{throw Error('completed days must be skipped')}});pass('064 affiliate page progress survives errors, finalizes completed days, omits missing days and skips completed planner ranges');

 // A failed cursor write must roll back the successful action insert too.
 await db.query("update dynamic_fee_affiliate_sync set scan_from=$1, scan_to=$2, scan_watermark=$3, source_base='fixture' where affiliate='integration'", [from, from + 86400, from + 3 * 86400]);
 const failingClient = { query: async (sql, values) => {
   if (sql.includes('update dynamic_fee_affiliate_sync set page_token')) throw new Error('injected cursor persistence failure');
   return db.query(sql, values);
 } };
 await assert.rejects(refreshAffiliateRange(failingClient, await sync(), {
   nowMs, fetchActions: async () => ({ actions: [action('must-rollback')], meta: { prevPageToken: 'later' } })
 }), /cursor persistence failure/);
 assert.equal((await db.query("select count(*) from dynamic_fee_affiliate_actions where action_key='MUST-ROLLBACK'")).rows[0].count, '0');
 // Populate enough real SQL rows to verify the display-detail cap independently
 // from complete persisted day totals.
 await db.query(`insert into dynamic_fee_affiliate_actions
   (affiliate, action_key, action_time, height, leg_volume_usd, raw_action)
   select 'integration', 'BULK-' || n, $1, 10, 4,
     jsonb_set($2::jsonb, '{in,0,txID}', to_jsonb('BULK-' || n))
   from generate_series(1, 1001) n`, [from + 60, JSON.stringify(action('template'))]);
 const detail = await readAffiliateVolume(db, params);
 assert.equal(detail.transactions.length, 1000);
 assert.equal(detail.transactions_truncated, true);
 assert.equal(detail.routeCount, 2, 'bounded details must not replace the complete aggregate');
 pass('064 action/cursor rollback and 1000-row detail cap');

 assert.equal(await readVisitorSnapshot(db,'vault'),null);let builds=0;const visitors=await refreshVisitorSnapshots(db,{build:async(kind)=>{builds++;return {kind,field_meta:{source:{fetched_at:NOW}}}}});assert.equal(visitors.errors.length,0);assert.equal(builds,2);assert.equal((await readVisitorSnapshot(db,'vault')).kind,'vault');await refreshVisitorSnapshots(db,{build:async()=>{throw Error('no pending requests')}});pass('064 visitor demand queue, initial prime, durable response and idle skip');
 console.log(`${checks} integration groups PASS`);
}finally{await db.end();}
