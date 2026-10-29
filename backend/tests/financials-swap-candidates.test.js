import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { parseFinancialSwapCandidates, verifyFinancialSwapCandidates } from '../src/shared/financials-swap-candidates.js';
import { parseFinancialRevshareBlock, saveFinancialRewardBlocks } from '../src/shared/financials-reward-source.js';
import { readFinancialDay, refreshFinancialDayQueue } from '../src/shared/financials-day-detail.js';

// 2026-10-27's $416K BTC.BTC -> ETH.ETH streaming swap (96 sub-swaps, one per
// block) was missing from production's top ten after the Midgard actions scan
// stalled. Its finalized events reached the block listener all along.
const TX = '47086B4A29E5817F4AEC574BEFB836AF220800BCF32B2991E1AF1E5A8C5ACA00';
const day = '2026-10-27', dayEnd = Date.parse('2026-10-28T00:00:00Z');
const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const postgres = { skip: !databaseUrl };

const event = (type, attributes) => ({ type,
  attributes: Object.entries(attributes).map(([key, value]) => ({ key, value, index: true })) });
const leg = (pool, coin, emit, fee, count, target = '0') => event('swap', { pool, swap_target: target, swap_slip: '10',
  liquidity_fee: '0', liquidity_fee_in_rune: fee, emit_asset: emit, streaming_swap_quantity: '96',
  streaming_swap_count: String(count), pool_slip: '3', stable_reserve: 'false', id: TX, chain: 'BTC',
  from: 'bc1qhsq34lp2zm6hfljnknv3l0a9e86sjywzljsyxx', to: 'bc1qrqrefwzvtv50r539hn7umufj84gm2xx9vz7ykw', coin,
  memo: '=:e:0x3a0c6489be9062a57966a2ad847124b5c781ebc0:17543329694/1/0', mode: 'EndBlock' });
const firstBlock = { height: 28420088, time: '2026-10-27T13:29:41.447725513Z', events: [
  leg('BTC.BTC', '5386042 BTC.BTC', '690494480727 THOR.RUNE', '691185666', 1),
  leg('ETH.ETH', '690494480727 THOR.RUNE', '184811856 ETH.ETH', '691529251', 1, '182743029')] };
const lastBlock = { height: 28420183, time: '2026-10-27T13:39:26.829838821Z', events: [
  leg('BTC.BTC', '5386041 BTC.BTC', '690231627566 THOR.RUNE', '690922550', 96),
  leg('ETH.ETH', '690231627566 THOR.RUNE', '184452906 ETH.ETH', '690459552', 96, '14120528'),
  event('streaming_swap', { tx_id: TX, interval: '1', quantity: '96', count: '96', last_height: '28420183',
    deposit: '517060000 BTC.BTC', in: '517060000 BTC.BTC', out: '17713662072 ETH.ETH',
    failed_swaps: '', failed_swap_reasons: '' })] };
const observe = block => ({ ...parseFinancialRevshareBlock({ result: { height: String(block.height),
  finalize_block_events: block.events } }, block.height), blockTime: block.time, source: 'thorchain-rpc:rev_share.payout' });

const midgard = status => async route => {
  assert.equal(new URL(route, 'https://example.test').searchParams.get('txid'), TX);
  return { actions: [{ type: 'swap', status, date: String(BigInt(Date.parse('2026-10-27T13:29:41Z')) * 1000000n),
    pools: ['BTC.BTC', 'ETH.ETH'], in: [{ txID: TX, coins: [{ asset: 'BTC.BTC', amount: '517060000' }] }],
    out: status === 'success' ? [{ coins: [{ asset: 'ETH.ETH', amount: '17713662072' }] }] : [],
    metadata: { swap: { inPriceUSD: '80469.7', liquidityFee: '138314302000', isStreamingSwap: true } } }] };
};
const storedDay = through => ({ day, through: new Date(through).toISOString(), observedAt: new Date(through).toISOString(),
  swaps: [{ txId: 'STALE', timestamp: '2026-10-27T01:00:00.000Z', inputAsset: 'BTC.BTC', inputAmount: 1,
    outputAsset: 'ETH.ETH', volumeUsd: 1, streaming: false }],
  pools: [], pendingSwaps: 0, unpricedSwaps: 0, excludedSwaps: [], exclusionsIncomplete: false });

async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `financials_swaps_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query("set local time zone 'Pacific/Honolulu'");
    for (const migration of ['051_pool_analysis.sql', '066_pool_analysis_intraday_snapshots.sql',
      '067_financials_reward_accounting.sql', '068_financials_day_details.sql',
      '072_financials_background_rosters.sql', '073_financials_swap_candidates.sql', '074_financials_swap_fees.sql',
      '075_financials_local_fee_rankings.sql', '076_financials_fee_candidates.sql', '077_financials_pool_swap_fees.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim, '').replaceAll('public.', ''));
    }
    // The ledger owns every UTC day that starts after it began recording.
    await client.query(`update financials_swap_ledger set started_at = '2026-10-26T00:00:00Z', fee_started_at = '2026-10-26T00:00:00Z'`);
    await client.query("insert into pool_analysis_daily(asset,day,rune_price_usd) values ('BTC.BTC','2026-10-27',0.5)");
    await run(client);
  } finally { await client.query('rollback'); await client.end(); }
}

const byTx = rows => [...rows].sort((a, b) => a.txId.localeCompare(b.txId));

test('a stream records every block fee, with input valuation at its first and last block', () => {
  assert.deepEqual(parseFinancialSwapCandidates(firstBlock.events), [{ txId: TX, inputAsset: 'BTC.BTC',
    inputE8: '517060032', runeValueE8: '66353823973728', outputAsset: 'ETH.ETH', streaming: true, started: true, complete: false, feeRuneE8: '1382714917' }]);
  assert.deepEqual(parseFinancialSwapCandidates(lastBlock.events), [{ txId: TX, inputAsset: 'BTC.BTC',
    inputE8: '517060000', runeValueE8: '66328573021070', outputAsset: 'ETH.ETH', streaming: true, started: false, complete: true, feeRuneE8: '1381382102' }]);
  const middle = leg('BTC.BTC', '5386040 BTC.BTC', '690000000000 THOR.RUNE', '690000000', 50);
  assert.equal(parseFinancialSwapCandidates([middle])[0].feeRuneE8, '690000000', 'intermediate sub-swaps contribute fees');
  const runeIn = event('swap', { pool: 'ETH.ETH', coin: '1000000000000 THOR.RUNE', emit_asset: '250000000 ETH.ETH',
    liquidity_fee_in_rune: '1000000000', streaming_swap_quantity: '1', streaming_swap_count: '1', id: 'runein' });
  assert.deepEqual(parseFinancialSwapCandidates([runeIn]), [{ txId: 'RUNEIN', inputAsset: 'THOR.RUNE',
    inputE8: '1000000000000', runeValueE8: '1000000000000', outputAsset: 'ETH.ETH', streaming: false, started: true, complete: true, feeRuneE8: '1000000000' }]);
  // A completion whose own final sub-swap failed uses another swap's rate for the same asset in that block.
  const other = event('swap', { pool: 'BTC.BTC', coin: '100000000 BTC.BTC', emit_asset: '1000000000000 THOR.RUNE',
    liquidity_fee_in_rune: '0', streaming_swap_quantity: '1', streaming_swap_count: '1', id: 'other' });
  const partial = event('streaming_swap', { tx_id: 'partial', interval: '1', quantity: '4', count: '4',
    deposit: '200000000 BTC.BTC', in: '150000000 BTC.BTC', out: '1000000000 ETH.ETH', failed_swaps: '3', failed_swap_reasons: '' });
  assert.deepEqual(byTx(parseFinancialSwapCandidates([other, partial])), [
    { txId: 'OTHER', inputAsset: 'BTC.BTC', inputE8: '100000000', runeValueE8: '1000000000000', outputAsset: 'THOR.RUNE',
      streaming: false, started: true, complete: true, feeRuneE8: '0' },
    { txId: 'PARTIAL', inputAsset: 'BTC.BTC', inputE8: '200000000', runeValueE8: '2000000000000', outputAsset: 'ETH.ETH',
      streaming: true, started: false, complete: true, feeRuneE8: '0' }]);
});

test('arrival order does not matter: the start dates a stream and its completion sizes it', postgres, async () => {
  for (const order of [[firstBlock, lastBlock], [lastBlock, firstBlock]]) {
    await withDatabase(async client => {
      for (const block of order) await saveFinancialRewardBlocks(client, [observe(block)]);
      const { rows } = await client.query(`select tx_id, day::text, first_height::text, first_seen_at, completed_at,
        input_e8::text, started, complete from financials_swap_candidates`);
      assert.deepEqual(rows.map(row => [row.tx_id, row.day, row.first_height, row.first_seen_at.toISOString(),
        row.completed_at.toISOString(), row.input_e8, row.started, row.complete]),
      [[TX, '2026-10-27', '28420088', '2026-10-27T13:29:41.447Z', '2026-10-27T13:39:26.829Z', '517060000', true, true]]);
    });
  }
});

test('the stream ledger ranks a swap the Midgard actions scan never saw', postgres, async () => {
  await withDatabase(async client => {
    await saveFinancialRewardBlocks(client, [observe(firstBlock), observe(lastBlock)]);
    await client.query('insert into financials_day_rankings (day, payload_json) values ($1, $2)', [day, storedDay(dayEnd)]);
    const at = dayEnd + 3600_000;
    await verifyFinancialSwapCandidates(client, { getJson: midgard('success'), now: () => at });
    const detail = await readFinancialDay(day, { client, now: () => at });
    assert.deepEqual(detail.swaps.map(row => [row.txId, row.inputAsset, row.inputAmount, row.outputAsset, row.streaming, row.timestamp]),
      [[TX, 'BTC.BTC', 5.1706, 'ETH.ETH', true, '2026-10-27T13:29:41.447Z']]);
    assert.ok(Math.abs(detail.swaps[0].volumeUsd - 5.1706 * 80469.7) < 0.01);
    assert.equal(detail.pendingSwaps, 0);
  });
});

test('an in-progress stream is disclosed from its start without a Midgard lookup, then ranks once it completes', postgres, async () => {
  await withDatabase(async client => {
    const early = Date.parse('2026-10-27T13:35:00Z');
    await saveFinancialRewardBlocks(client, [observe(firstBlock)]);
    await client.query('insert into financials_day_rankings (day, payload_json) values ($1, $2)', [day, storedDay(early)]);
    let lookups = 0;
    await verifyFinancialSwapCandidates(client, { getJson: async () => { lookups++; return { actions: [] }; }, now: () => early });
    assert.equal(lookups, 0, 'an unfinished stream costs no Midgard request');
    let detail = await readFinancialDay(day, { client, now: () => early });
    assert.deepEqual(detail.swaps, []);
    assert.equal(detail.pendingSwaps, 1);
    assert.deepEqual(detail.excludedSwaps, [{ txId: TX, kind: 'pending' }]);
    await saveFinancialRewardBlocks(client, [observe(lastBlock)]);
    const later = Date.parse('2026-10-27T13:45:00Z');
    await verifyFinancialSwapCandidates(client, { getJson: midgard('success'), now: () => later });
    detail = await readFinancialDay(day, { client, now: () => later });
    assert.deepEqual(detail.swaps.map(row => row.txId), [TX]);
    assert.equal(detail.pendingSwaps, 0);
  });
});

test('the collector never pages Midgard actions for a day the stream ledger covers', async () => {
  const at = Date.parse('2026-10-27T12:10:00Z'), from = Date.parse(`${day}T00:00:00Z`) / 1000, through = from + 12 * 3600;
  const buckets = extra => Array.from({ length: (through - from) / 300 }, (_, i) =>
    ({ startTime: String(from + i * 300), endTime: String(from + (i + 1) * 300), ...extra }));
  const routes = [];
  const client = { query: async sql => {
    if (/financials_swap_ledger/.test(sql)) return { rows: [{ started_at: new Date('2026-10-26T00:00:00Z') }] };
    if (sql.trimStart().startsWith('select')) return { rows: [{ day, state_json: null, payload_json: null, background: true }] };
    return { rows: [] };
  } };
  await refreshFinancialDayQueue(client, { now: () => at, maxRequests: 10, getJson: async route => {
    routes.push(route.split('?')[0]);
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: at / 1000 } };
    if (route.startsWith('/history/earnings')) return { intervals: buckets({ pools: [{ pool: 'BTC.BTC' }] }) };
    if (route.startsWith('/history/swaps')) return { intervals: buckets({ totalVolume: '100', totalVolumeUSD: '100' }) };
    return assert.fail(`unexpected provider request ${route}`);
  } });
  assert.deepEqual(routes, ['/health', '/history/earnings', '/history/swaps']);
});
