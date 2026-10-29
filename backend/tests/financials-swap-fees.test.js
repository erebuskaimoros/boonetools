import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { fillFinancialSwapFees, financialSwapRow } from '../src/shared/financials-swap-candidates.js';
import { readFinancialDay } from '../src/shared/financials-day-detail.js';

// 2026-10-29's RUNE -> BTC~BTC swap: Midgard reports its liquidity fee in RUNE.
const TX = '7B57322084CB2CAD0FE4EF46D2055E5B83D77823C58F70089BE8F4DF45411624';
const day = '2026-10-29', dayEnd = Date.parse('2026-10-30T00:00:00Z');
const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const postgres = { skip: !databaseUrl };
const action = { type: 'swap', status: 'success', date: String(BigInt(Date.parse('2026-10-29T01:42:19Z')) * 1000000n),
  pools: ['BTC.BTC'], in: [{ txID: TX, coins: [{ asset: 'THOR.RUNE', amount: '2312389339232' }] }],
  out: [{ coins: [{ asset: 'BTC~BTC', amount: '17672847' }] }],
  metadata: { swap: { inPriceUSD: '0.6213014558320356', liquidityFee: '2278780120', swapSlip: '10', isStreamingSwap: false } } };

async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `financials_fees_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query("set local time zone 'Pacific/Honolulu'");
    for (const migration of ['051_pool_analysis.sql', '066_pool_analysis_intraday_snapshots.sql', '068_financials_day_details.sql',
      '072_financials_background_rosters.sql', '073_financials_swap_candidates.sql', '074_financials_swap_fees.sql',
      '075_financials_local_fee_rankings.sql', '076_financials_fee_candidates.sql', '077_financials_pool_swap_fees.sql', '078_financials_verification_pause.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim, '').replaceAll('public.', ''));
    }
    // A day from before the stream ledger: its stored scan rows predate fee fields.
    await client.query(`update financials_swap_ledger set started_at = '2099-01-01T00:00:00Z', fee_started_at = '2099-01-01T00:00:00Z'`);
    await run(client);
  } finally { await client.query('rollback'); await client.end(); }
}

test('a ranked swap row carries Midgard\'s liquidity fee in RUNE', () => {
  const { row } = financialSwapRow(action);
  assert.equal(row.feeRune, 22.7878012);
  assert.ok(Math.abs(row.volumeUsd - 23123.89339232 * 0.6213014558320356) < 1e-6);
});

test('legacy fills remain idempotent and cannot seed new fee rankings; new rows use the swap\'s 15-minute RUNE rate', postgres, async () => {
  await withDatabase(async client => {
    const volumeUsd = 23123.89339232 * 0.6213014558320356;
    await client.query('insert into financials_day_details (day, payload_json) values ($1, $2)', [day, {
      day, through: new Date(dayEnd).toISOString(), observedAt: new Date(dayEnd).toISOString(),
      swaps: [{ txId: TX, timestamp: '2026-10-29T01:42:19.000Z', inputAsset: 'THOR.RUNE', inputAmount: 23123.89339232,
        outputAsset: 'BTC~BTC', volumeUsd, streaming: false }],
      pools: [], pendingSwaps: 0, unpricedSwaps: 0, excludedSwaps: [], exclusionsIncomplete: false }]);
    // The swap falls in the 01:30-01:45 bucket, which closes at the 01:45 prefix.
    for (const [end, price] of [['01:30', '0.6'], ['01:45', '0.6213014558320356'], ['02:00', '0.65']]) {
      await client.query(`insert into pool_analysis_intraday_snapshots
        (asset, bucket_end, volume_rune_e8, volume_usd_e2, fees_rune_e8, rune_price_usd) values ('BTC.BTC', $1, 0, 0, 0, $2)`,
      [`${day}T${end}:00Z`, price]);
    }
    const at = dayEnd + 3600_000;
    let lookups = 0;
    const getJson = async route => {
      lookups++;
      assert.equal(new URL(route, 'https://example.test').searchParams.get('txid'), TX);
      return { actions: [action] };
    };
    await fillFinancialSwapFees(client, { getJson, now: () => at });
    await fillFinancialSwapFees(client, { getJson, now: () => at });
    assert.equal(lookups, 1, 'each stored transaction is looked up once');
    const cold = await readFinancialDay(day, { client, now: () => at });
    assert.equal(cold.loading, true, 'legacy volume top ten is not reinterpreted as a fee ranking');
    await client.query('update financials_day_rankings set payload_json = $2 where day = $1', [day, {
      day, through: new Date(dayEnd).toISOString(), observedAt: new Date(dayEnd).toISOString(),
      swaps: [financialSwapRow(action).row], pools: [], pendingSwaps: 0, unpricedSwaps: 0,
      excludedSwaps: [], exclusionsIncomplete: false, swapRankingBasis: 'liquidity-fees-usd' }]);
    const detail = await readFinancialDay(day, { client, now: () => at });
    const [swap] = detail.swaps;
    assert.equal(swap.feeRune, 22.7878012);
    assert.ok(Math.abs(swap.feeUsd - 22.7878012 * 0.6213014558320356) < 1e-9);
    assert.ok(Math.abs(swap.feeRate - swap.feeUsd / volumeUsd) < 1e-12);
  });
});
