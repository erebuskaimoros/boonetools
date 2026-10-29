import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { parseFinancialSwapCandidates, verifyFinancialSwapCandidates, readFinancialSwapLedgerDay,
  financialSwapRow, financialSwapLedgerCovers, readFinancialSwapLedgerStart,
  priceFinancialSwapRowsAtPrices } from '../src/shared/financials-swap-candidates.js';
import { parseFinancialRevshareBlock, saveFinancialRewardBlocks } from '../src/shared/financials-reward-source.js';

const event = (id, coin, emit, fee, count = 1, quantity = 1) => ({ type: 'swap', attributes:
  Object.entries({ id, coin, emit_asset: emit, liquidity_fee_in_rune: fee,
    streaming_swap_count: String(count), streaming_swap_quantity: String(quantity) })
    .map(([key, value]) => ({ key, value })) });

test('fee candidates capture both legs and intermediate streaming blocks, including small inputs', () => {
  const rows = parseFinancialSwapCandidates([
    event('stream', '1000000 BTC.BTC', '10000000000 THOR.RUNE', '100000000', 2, 4),
    event('stream', '10000000000 THOR.RUNE', '10000000 ETH.ETH', '200000000', 2, 4),
    event('small', '100000000 THOR.RUNE', '1000 BTC.BTC', '50000000')
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.txId === 'STREAM').feeRuneE8, '300000000');
  assert.equal(rows.find(row => row.txId === 'STREAM').started, false);
  assert.equal(rows.find(row => row.txId === 'STREAM').complete, false);
  assert.equal(rows.find(row => row.txId === 'SMALL').feeRuneE8, '50000000');
});

test('known fees remain rankable without input notional and absent prices never become zero fees', () => {
  const { row } = financialSwapRow({ type: 'swap', status: 'success', date: '1793250000000000000',
    in: [{ txID: 'known-fees', coins: [{ asset: 'BTC.BTC', amount: '100000000' }] }],
    out: [{ coins: [{ asset: 'THOR.RUNE', amount: '100000000' }] }],
    metadata: { swap: { liquidityFee: '200000000', outPriceUSD: '0.5' } } });
  assert.equal(row.volumeUsd, null);
  assert.equal(row.feeUsd, 1);
  assert.equal(row.feeRate, null);
  const [unknown] = priceFinancialSwapRowsAtPrices([{ ...row, runePriceUsd: null }],
    [{ from: 0, to: 1, price: 10 }]);
  assert.equal(unknown.feeUsd, null);
});

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const postgres = { skip: !databaseUrl };
async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `fee_ledger_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query("set local time zone 'Pacific/Honolulu'");
    for (const migration of ['051_pool_analysis.sql', '066_pool_analysis_intraday_snapshots.sql', '067_financials_reward_accounting.sql',
      '068_financials_day_details.sql', '072_financials_background_rosters.sql', '073_financials_swap_candidates.sql',
      '074_financials_swap_fees.sql', '075_financials_local_fee_rankings.sql', '076_financials_fee_candidates.sql', '077_financials_pool_swap_fees.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim, '').replaceAll('public.', ''));
    }
    await client.query("update financials_swap_ledger set fee_started_at = '2026-10-28T00:00:00Z'");
    await run(client);
  } finally { await client.query('rollback'); await client.end(); }
}

const observed = (height, time, events) => ({ ...parseFinancialRevshareBlock({ result: {
  height: String(height), finalize_block_events: events } }, height), blockTime: time });

test('fee capture includes small swaps, sums all stream blocks, and is replay safe in either arrival order', postgres, async () => {
  const blocks = [
    observed(10, '2026-10-29T03:59:00Z', [event('stream', '50000000 THOR.RUNE', '1000 BTC.BTC', '10000000', 1, 3)]),
    observed(11, '2026-10-29T04:00:00Z', [event('stream', '50000000 THOR.RUNE', '1000 BTC.BTC', '20000000', 2, 3)]),
    observed(12, '2026-10-29T04:01:00Z', [event('stream', '50000000 THOR.RUNE', '1000 BTC.BTC', '30000000', 3, 3),
      { type: 'streaming_swap', attributes: Object.entries({ tx_id: 'stream', deposit: '150000000 THOR.RUNE', out: '3000 BTC.BTC' })
        .map(([key, value]) => ({ key, value })) }])
  ];
  for (const order of [blocks, [...blocks].reverse()]) await withDatabase(async client => {
    for (const block of order) await saveFinancialRewardBlocks(client, [block]);
    await saveFinancialRewardBlocks(client, [...blocks, ...blocks]);
    const [row] = (await client.query('select first_seen_at, day::text, fee_rune_e8::text, input_e8::text, started, complete from financials_swap_candidates')).rows;
    assert.equal(row.first_seen_at.toISOString(), '2026-10-29T03:59:00.000Z');
    assert.equal(row.fee_rune_e8, '60000000');
    assert.equal(row.input_e8, '150000000');
    assert.equal(row.started, true);
    assert.equal(row.complete, true);
    assert.equal((await client.query('select count(*)::int as n from financials_swap_fee_blocks')).rows[0].n, 3);
    await verifyFinancialSwapCandidates(client, { now: () => Date.parse('2026-10-29T05:00:00Z'), getJson: async () => ({ actions: [{
      type: 'swap', status: 'success', date: '1793246460000000000',
      in: [{ txID: 'STREAM', coins: [{ asset: 'THOR.RUNE', amount: '150000000' }] }],
      out: [{ coins: [{ asset: 'BTC.BTC', amount: '3000' }] }],
      metadata: { swap: { inPriceUSD: '0.5', liquidityFee: '60000000' } }
    }] }) });
    const result = await readFinancialSwapLedgerDay(client, { from: Date.parse('2026-10-29T04:00:00Z') / 1000,
      to: Date.parse('2026-10-30T04:00:00Z') / 1000 });
    assert.deepEqual(result.swaps, [], 'a stream started on the previous local day stays there after completion');
    const stored = (await client.query('select verified_row from financials_swap_candidates')).rows[0].verified_row;
    assert.equal(stored.timestamp, '2026-10-29T03:59:00.000Z');
  });
});

test('local windows verify fee leaders outside the UTC top 25', postgres, async () => withDatabase(async client => {
  const now = Date.parse('2026-10-29T06:00:00Z');
  await client.query("insert into financials_day_rankings(day,time_zone,background) values ('2026-10-29','America/New_York',true)");
  await client.query("insert into pool_analysis_daily(asset,day,rune_price_usd) values ('BTC.BTC','2026-10-29',0.5)");
  for (let index = 0; index < 31; index++) {
    const tx = index === 30 ? 'LOCAL' : `UTC-${index}`;
    const instant = index === 30 ? '2026-10-29T04:30:00Z' : '2026-10-29T01:00:00Z';
    await client.query(`insert into financials_swap_candidates(tx_id,day,first_height,first_seen_at,input_asset,input_e8,
      rune_value_e8,output_asset,streaming,started,complete,completed_at,status,fee_rune_e8,verified_row)
      values ($1,'2026-10-29',100,$2,'THOR.RUNE',100000000,100000000,'BTC.BTC',false,true,true,$2,$3,$4,$5)`,
    [tx, instant, index === 30 ? 'observed' : 'verified', index === 30 ? '100000000' : '10000000000',
      index === 30 ? null : { txId: tx, timestamp: instant, feeRune: 100 }]);
  }
  const checked = [];
  await verifyFinancialSwapCandidates(client, { now: () => now, maxRequests: 1, getJson: async route => {
    checked.push(new URL(route, 'https://example.test').searchParams.get('txid'));
    return { actions: [{ type: 'swap', status: 'success', date: String(BigInt(Date.parse('2026-10-29T04:30:00Z')) * 1000000n),
      in: [{ txID: 'LOCAL', coins: [{ asset: 'THOR.RUNE', amount: '100000000' }] }],
      out: [{ coins: [{ asset: 'BTC.BTC', amount: '10' }] }], metadata: { swap: { inPriceUSD: '0.5', liquidityFee: '100000000' } } }] };
  } });
  assert.deepEqual(checked, ['LOCAL']);
  const ledger = await readFinancialSwapLedgerDay(client, { from: Date.parse('2026-10-29T04:00:00Z') / 1000,
    to: Date.parse('2026-10-30T04:00:00Z') / 1000 });
  assert.deepEqual(ledger.swaps.map(row => [row.txId, row.feeUsd]), [['LOCAL', 0.5]]);
  await client.query(`insert into financials_swap_candidates(tx_id,day,first_height,first_seen_at,input_asset,input_e8,
    rune_value_e8,streaming,started,complete,completed_at,fee_rune_e8)
    values ('LOWER','2026-10-29',100,'2026-10-29T01:30:00Z','THOR.RUNE',100,100,false,true,true,
      '2026-10-29T01:30:00Z',100)`);
  const utc = await readFinancialSwapLedgerDay(client, '2026-10-29');
  assert.deepEqual(utc.pending, [], 'lower-ranked observations do not stay pending after the leaders are verified');
  await client.query(`update financials_swap_candidates set complete = false, completed_at = null, streaming = true
    where tx_id = 'LOWER'`);
  const unfinished = await readFinancialSwapLedgerDay(client, '2026-10-29');
  assert.deepEqual(unfinished.pending, ['LOWER'], 'unfinished streams may accrue enough fees to enter the top ten later');
  assert.equal(unfinished.nextCheckAt, null, 'unfinished streams wait for completion rather than polling Midgard');
  const start = await readFinancialSwapLedgerStart(client);
  assert.equal(financialSwapLedgerCovers(start, { from: Date.parse('2026-10-27T04:00:00Z') / 1000 }), false);
  assert.equal(financialSwapLedgerCovers(start, { from: Date.parse('2026-10-29T04:00:00Z') / 1000 }), true);
}));

test('candidate priority uses USD fees rather than native fees or input value', postgres, async () => withDatabase(async client => {
  const blocks = [
    observed(20, '2026-10-29T04:01:00Z', [event('more-rune', '1000000000000 THOR.RUNE', '100 BTC.BTC', '6000000000')]),
    observed(21, '2026-10-29T05:01:00Z', [event('more-usd', '100000000000 THOR.RUNE', '100 BTC.BTC', '1000000000')])
  ];
  await saveFinancialRewardBlocks(client, blocks);
  for (const [end, price] of [['04:15', 0.2], ['05:15', 2]]) await client.query(`insert into pool_analysis_intraday_snapshots
    (asset,bucket_end,volume_rune_e8,volume_usd_e2,fees_rune_e8,rune_price_usd) values ('BTC.BTC',$1,0,0,0,$2)`,
  [`2026-10-29T${end}:00Z`, price]);
  const checked = [];
  await verifyFinancialSwapCandidates(client, { now: () => Date.parse('2026-10-29T06:00:00Z'), maxRequests: 1,
    getJson: async route => { checked.push(new URL(route, 'https://example.test').searchParams.get('txid')); return { actions: [] }; } });
  assert.deepEqual(checked, ['MORE-USD']);
}));

test('a budget-deferred leader keeps its targeted retry after the three-day window rolls forward', postgres, async () => withDatabase(async client => {
  await saveFinancialRewardBlocks(client, [observed(30, '2026-10-29T05:01:00Z',
    [event('delayed', '100000000000 THOR.RUNE', '100 BTC.BTC', '1000000000')])]);
  const early = Date.parse('2026-10-29T06:00:00Z');
  await verifyFinancialSwapCandidates(client, { now: () => early, getJson: async () => {
    throw Object.assign(new Error('quota reached'), { code: 'MIDGARD_BUDGET_DEFERRED', skipProvider: true });
  } });
  assert.equal((await client.query('select count(*)::int as n from financials_swap_verification_windows')).rows[0].n, 1);
  let lookups = 0;
  await verifyFinancialSwapCandidates(client, { now: () => Date.parse('2026-11-03T06:00:00Z'), getJson: async route => {
    lookups++;
    assert.equal(new URL(route, 'https://example.test').searchParams.get('txid'), 'DELAYED');
    return { actions: [{ type: 'swap', status: 'success', date: '1793250060000000000',
      in: [{ txID: 'DELAYED', coins: [{ asset: 'THOR.RUNE', amount: '100000000000' }] }],
      out: [{ coins: [{ asset: 'BTC.BTC', amount: '100' }] }], metadata: { swap: { inPriceUSD: '0.5', liquidityFee: '1000000000' } } }] };
  } });
  assert.equal(lookups, 1);
  assert.equal((await client.query('select count(*)::int as n from financials_swap_verification_windows')).rows[0].n, 0);
  const ledger = await readFinancialSwapLedgerDay(client, '2026-10-29');
  assert.deepEqual(ledger.swaps.map(row => row.txId), ['DELAYED']);
  assert.deepEqual(ledger.pending, []);
}));
