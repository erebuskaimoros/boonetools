import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readStableSwapDays } from '../src/shared/dynamic-fee-stable-swaps.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const postgres = { skip: !databaseUrl };
const nowMs = Date.parse('2026-11-13T15:00:00Z');

async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `stable_swaps_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    for (const migration of ['053_protocol_mimir_changes.sql', '073_financials_swap_candidates.sql', '076_financials_fee_candidates.sql',
      '080_dynamic_fee_stable_swap_backfill.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim, '').replaceAll('public.', ''));
    }
    await run(client);
  } finally { await client.query('rollback'); await client.end(); }
}

async function insertCandidate(client, { txId, day, input, inputE8, runeE8, output, feeE8, statusValue = 'observed' }) {
  await client.query(`insert into financials_swap_candidates (tx_id, day, first_height, first_seen_at, input_asset, input_e8,
      rune_value_e8, output_asset, streaming, started, complete, status, fee_rune_e8)
    values ($1, $2::date, 1, $2::date, $3, $4, $5, $6, false, true, true, $7, $8)`,
  [txId, day, input, inputE8, runeE8, output, statusValue, feeE8]);
}

test('readStableSwapDays aggregates non-excluded stable routes from the fee coverage start', postgres, async () => {
  await withDatabase(async client => {
    await client.query("update financials_swap_ledger set fee_started_at = '2026-11-10T08:00:00Z'");
    const rows = [
      // Before coverage: ignored.
      { txId: 'EARLY', day: '2026-11-10', input: 'ETH.USDC-0XA0B8', inputE8: '100000000000', runeE8: '50000000000', output: 'ETH.USDT-0XDAC1', feeE8: '100000000' },
      // 1,000 USD of input = 500 RUNE, so 1 RUNE of fee = 2 USD.
      { txId: 'L1', day: '2026-11-11', input: 'ETH.USDC-0XA0B8', inputE8: '100000000000', runeE8: '50000000000', output: 'ETH.USDT-0XDAC1', feeE8: '100000000' },
      { txId: 'TRADE', day: '2026-11-11', input: 'eth~usdt-0xdac1', inputE8: '30000000000', runeE8: '10000000000', output: 'ETH~USDC-0XA0B8', feeE8: '50000000' },
      { txId: 'SECURED', day: '2026-11-13', input: 'ETH-DAI-0X6B17', inputE8: '20000000000', runeE8: '10000000000', output: 'BSC-USDT-0X55D3', feeE8: '10000000' },
      { txId: 'TO-BTC', day: '2026-11-11', input: 'ETH.USDC-0XA0B8', inputE8: '900000000000', runeE8: '1', output: 'BTC.BTC', feeE8: '900000000' },
      { txId: 'EXCLUDED', day: '2026-11-11', input: 'ETH.USDC-0XA0B8', inputE8: '900000000000', runeE8: '1', output: 'ETH.USDT-0XDAC1', feeE8: '900000000', statusValue: 'excluded' },
      { txId: 'NO-RUNE-VALUE', day: '2026-11-12', input: 'ETH.USDC-0XA0B8', inputE8: '7000000000', runeE8: '0', output: 'ETH.USDT-0XDAC1', feeE8: '30000000' }
    ];
    for (const row of rows) await insertCandidate(client, row);

    assert.deepEqual(await readStableSwapDays(client, { days: 400, nowMs }), {
      as_of: '2026-11-13T15:00:00.000Z',
      coverage_start: '2026-11-11',
      ledger_start: '2026-11-11',
      stable_symbols: ['USDC', 'USDT', 'DAI', 'GUSD', 'LUSD', 'USDP', 'BUSD'],
      source: 'finalized-block swap ledger',
      backfill: null,
      mimir_changes: [],
      days: [
        { day: '2026-11-11', swaps: 2, volume_usd: 1300, fees_rune: 1.5, fees_usd: 3.5, partial: false },
        { day: '2026-11-12', swaps: 1, volume_usd: 70, fees_rune: 0.3, fees_usd: null, partial: false },
        { day: '2026-11-13', swaps: 1, volume_usd: 200, fees_rune: 0.1, fees_usd: 0.2, partial: true }
      ]
    });

    const recent = await readStableSwapDays(client, { days: 1, nowMs });
    assert.deepEqual(recent.days.map(day => day.day), ['2026-11-13']);

    await client.query('delete from financials_swap_ledger');
    const missing = await readStableSwapDays(client, { days: 400, nowMs });
    assert.equal(missing.coverage_start, null);
    assert.equal(missing.ledger_start, null);
    assert.deepEqual(missing.days, []);
  });
});

async function insertBackfillDay(client, day, price, swaps = []) {
  for (const swap of swaps) {
    await client.query(`insert into dynamic_fee_stable_swap_backfill_swaps
        (action_key, day, action_time, height, input_asset, input_e8, output_asset, fee_rune_e8)
      values ($1, $2::date, extract(epoch from $2::date)::bigint, 1, $3, $4, $5, $6)`,
    [swap.key, day, swap.input, swap.inputE8, swap.output, swap.feeE8]);
  }
  if (price !== undefined) {
    await client.query(`insert into dynamic_fee_stable_swap_backfill_days (day, rune_price_usd, swaps)
      values ($1::date, $2, $3)`, [day, price, swaps.length]);
  }
}

test('readStableSwapDays prepends contiguous completed backfill days priced at the daily RUNE price', postgres, async () => {
  await withDatabase(async client => {
    await client.query("update financials_swap_ledger set fee_started_at = '2026-11-11T00:00:00Z'");
    await insertCandidate(client, { txId: 'LIVE', day: '2026-11-11', input: 'ETH.USDC-0XA0B8', inputE8: '100000000000',
      runeE8: '50000000000', output: 'ETH.USDT-0XDAC1', feeE8: '100000000' });
    // A stream that started before the ledger start and is owned by its ledger day.
    await insertCandidate(client, { txId: 'STRADDLE', day: '2026-11-11', input: 'ETH.USDC-0XA0B8', inputE8: '40000000000',
      runeE8: '20000000000', output: 'ETH.USDT-0XDAC1', feeE8: '20000000' });
    // A pre-fee candidate dated before the ledger start does not suppress the backfill.
    await insertCandidate(client, { txId: 'PREFEE', day: '2026-11-09', input: 'ETH.USDC-0XA0B8', inputE8: '1',
      runeE8: '1', output: 'ETH.USDT-0XDAC1', feeE8: '0' });
    await client.query(`insert into dynamic_fee_stable_swap_backfill (ledger_start, target_start, asset_filter, omitted_asset, scan_day)
      values ('2026-11-11', '2026-11-06', '[]', 'ETH.USDT-0XDAC1', '2026-11-08')`);
    const usdc = 'ETH.USDC-0XA0B8';
    const usdt = 'ETH~USDT-0XDAC1';
    await insertBackfillDay(client, '2026-11-10', '2', [
      { key: 'STRADDLE', input: usdc, inputE8: '40000000000', output: usdt, feeE8: '20000000' },
      { key: 'B1', input: usdc, inputE8: '25000000000', output: usdt, feeE8: '100000000' },
      { key: 'TO-BTC', input: usdc, inputE8: '99900000000', output: 'BTC.BTC', feeE8: '100000000' }
    ]);
    await insertBackfillDay(client, '2026-11-09', null, [
      { key: 'PREFEE', input: usdc, inputE8: '10000000000', output: usdt, feeE8: '30000000' }
    ]);
    // Completed, but not contiguous with the ledger start: not served yet.
    await insertBackfillDay(client, '2026-11-07', '3', [
      { key: 'GAP', input: usdc, inputE8: '10000000000', output: usdt, feeE8: '30000000' }
    ]);
    // Rows of an unfinished day are never served.
    await insertBackfillDay(client, '2026-11-08', undefined, [
      { key: 'PARTIAL', input: usdc, inputE8: '10000000000', output: usdt, feeE8: '30000000' }
    ]);

    await client.query(`insert into protocol_mimir_changes (event_key, height, block_time, mimir_key, mimir_value) values
      ('a', 100, '2026-11-10T02:41:47Z', 'STABLESLIPMINBPS', '10'), ('b', 90, '2026-11-09T00:00:00Z', 'L1SLIPMINBPS', '5')`);
    const payload = await readStableSwapDays(client, { days: 400, nowMs });
    assert.deepEqual(payload, {
      as_of: '2026-11-13T15:00:00.000Z',
      coverage_start: '2026-11-09',
      ledger_start: '2026-11-11',
      stable_symbols: ['USDC', 'USDT', 'DAI', 'GUSD', 'LUSD', 'USDP', 'BUSD'],
      source: 'finalized-block swap ledger',
      backfill: { target_start: '2026-11-06', complete_from: '2026-11-09', complete: false, floor_reason: null },
      mimir_changes: [
        { key: 'STABLESLIPMINBPS', value: '10', previous_value: null, time: '2026-11-10T02:41:47.000Z', day: '2026-11-10', height: 100 }
      ],
      days: [
        { day: '2026-11-09', swaps: 1, volume_usd: 100, fees_rune: 0.3, fees_usd: null, partial: false },
        { day: '2026-11-10', swaps: 1, volume_usd: 250, fees_rune: 1, fees_usd: 2, partial: false },
        { day: '2026-11-11', swaps: 2, volume_usd: 1400, fees_rune: 1.2, fees_usd: 2.4, partial: false },
        { day: '2026-11-12', swaps: 0, volume_usd: 0, fees_rune: 0, fees_usd: 0, partial: false },
        { day: '2026-11-13', swaps: 0, volume_usd: 0, fees_rune: 0, fees_usd: 0, partial: true }
      ]
    });

    assert.deepEqual((await readStableSwapDays(client, { days: 4, nowMs })).days.map(day => day.day),
      ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], 'the days parameter still bounds the series');

    await insertBackfillDay(client, '2026-11-08', '1', []);
    await insertBackfillDay(client, '2026-11-06', '1', []);
    await client.query("update dynamic_fee_stable_swap_backfill set completed_at = now(), scan_day = null");
    const complete = await readStableSwapDays(client, { days: 400, nowMs });
    assert.deepEqual(complete.backfill, { target_start: '2026-11-06', complete_from: '2026-11-06', complete: true, floor_reason: null });
    assert.equal(complete.coverage_start, '2026-11-06');
    assert.deepEqual(complete.days.slice(0, 4).map(day => [day.day, day.swaps, day.fees_usd]),
      [['2026-11-06', 0, 0], ['2026-11-07', 1, 0.9], ['2026-11-08', 1, 0.3], ['2026-11-09', 1, null]]);

    // Backfill days scanned against another ledger start are not served.
    await client.query("update financials_swap_ledger set fee_started_at = '2026-11-12T00:00:00Z'");
    const moved = await readStableSwapDays(client, { days: 400, nowMs });
    assert.equal(moved.coverage_start, '2026-11-12');
    assert.equal(moved.days[0].day, '2026-11-12');
  });
});
