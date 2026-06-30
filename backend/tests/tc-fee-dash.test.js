import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFeesPerBillionUsd,
  normalizeTcFeeDashRow,
  summarizeTcFeeDashRows
} from '../src/shared/tc-fee-dash.js';
import {
  buildTcFeeDailyRowsFromMidgard,
  buildTcFeeDailyRowsFromDune,
  mergeTcFeeRowsForDays,
  parseDefiLlamaDexVolumeDays,
  parseCmcGlobalVolumeDays
} from '../src/shared/tc-fee-dash-ingestion.js';

test('computeFeesPerBillionUsd normalizes TC fees against global exchange volume', () => {
  assert.equal(Math.round(computeFeesPerBillionUsd(375_700, 1_033_000_000_000)), 364);
});

test('normalizeTcFeeDashRow converts DB row shape to API row shape', () => {
  const row = normalizeTcFeeDashRow({
    id: '2025-09-02_2025-09-09',
    window_start: '2025-09-02',
    window_end: '2025-09-09',
    window_label: 'Sep 2-Sep 9',
    period: 'weekly_seed',
    fee_bps: '10',
    tc_fees_rune: '1000',
    rune_price_usd: '3.757',
    tc_fees_usd: '375700',
    cmc_volume_24h_usd: '1000000000000',
    defillama_dex_volume_usd: '33000000000',
    global_exchange_volume_usd: '1033000000000',
    daily_median_fees_per_billion_usd: '273',
    daily_range_low_fees_per_billion_usd: '97',
    daily_range_high_fees_per_billion_usd: '711',
    source_label: 'chain-analysis fee table',
    source_thread: 'thread'
  });

  assert.equal(row.windowLabel, 'Sep 2-Sep 9');
  assert.equal(row.period, 'weekly_seed');
  assert.equal(row.feeBps, 10);
  assert.equal(row.tcFeesRune, 1000);
  assert.equal(row.runePriceUsd, 3.757);
  assert.equal(row.cmcVolume24hUsd, 1_000_000_000_000);
  assert.equal(row.defillamaDexVolumeUsd, 33_000_000_000);
  assert.equal(Math.round(row.feesPerBillionUsd), 364);
  assert.equal(row.dailyRangeHighFeesPerBillionUsd, 711);
});

test('summarizeTcFeeDashRows returns weighted aggregate and peak window', () => {
  const rows = [
    {
      windowLabel: 'low',
      tcFeesUsd: 103_500,
      globalExchangeVolumeUsd: 1_242_000_000_000,
      feesPerBillionUsd: computeFeesPerBillionUsd(103_500, 1_242_000_000_000)
    },
    {
      windowLabel: 'high',
      tcFeesUsd: 749_000,
      globalExchangeVolumeUsd: 1_479_000_000_000,
      feesPerBillionUsd: computeFeesPerBillionUsd(749_000, 1_479_000_000_000)
    }
  ];
  const summary = summarizeTcFeeDashRows(rows);

  assert.equal(summary.windowCount, 2);
  assert.equal(summary.totalTcFeesUsd, 852_500);
  assert.equal(summary.peak.windowLabel, 'high');
  assert.equal(Math.round(summary.weightedFeesPerBillionUsd), 313);
});

test('TC Fee Dash ingestion builds daily DB rows from Dune query rows', () => {
  const cmcVolumesByDate = new Map([[
    '2022-06-22',
    {
      cmcVolume24hUsd: 1_000_000_000_000,
      raw: { timestamp: '2022-06-22T00:00:00.000Z' }
    }
  ]]);
  const rows = buildTcFeeDailyRowsFromDune([{
    day: '2022-06-22',
    tc_fees_rune: 8155.28511795,
    rune_price_usd: 2.5,
    tc_fees_usd: 20388.212794875,
    market_volume_24h_usd: 0,
    dex_volume_usd: 1_050_000_000,
    exchange_volume_usd: 1_050_000_000,
    source_label: 'Dune thorchain.defi_daily_earnings + dex.trades',
    denominator_basis: 'Dune indexed DEX trade volume'
  }], {
    queryId: '7619850',
    cmcVolumesByDate
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'day:2022-06-22');
  assert.equal(rows[0].period, 'day');
  assert.equal(rows[0].window_end, '2022-06-23');
  assert.equal(rows[0].tc_fees_rune, 8155.28511795);
  assert.ok(Math.abs(rows[0].tc_fees_usd - 20388.212794875) < 0.00000001);
  assert.equal(rows[0].cmc_volume_24h_usd, 1_000_000_000_000);
  assert.equal(rows[0].global_exchange_volume_usd, 1_001_050_000_000);
  assert.equal(rows[0].source_thread, 'https://dune.com/queries/7619850');
  assert.equal(rows[0].source_json.cmc.timestamp, '2022-06-22T00:00:00.000Z');
  assert.equal(rows[0].source_json.denominatorBasis, 'CMC historical global volume plus Dune indexed DEX trade volume');
  assert.equal(Math.round(rows[0].source_json.feesPerBillionUsd), 20);
});

test('TC Fee Dash ingestion preserves zero-fee Dune days', () => {
  const cmcVolumesByDate = new Map([[
    '2026-05-16',
    {
      cmcVolume24hUsd: 100_000_000_000,
      raw: { timestamp: '2026-05-16T00:00:00.000Z' }
    }
  ]]);
  const rows = buildTcFeeDailyRowsFromDune([{
    day: '2026-05-16',
    tc_fees_rune: 0,
    rune_price_usd: 0.58,
    tc_fees_usd: 0,
    dex_volume_usd: 5_000_000_000
  }], {
    queryId: '7619850',
    cmcVolumesByDate
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].window_start, '2026-05-16');
  assert.equal(rows[0].tc_fees_rune, 0);
  assert.equal(rows[0].tc_fees_usd, 0);
  assert.equal(rows[0].global_exchange_volume_usd, 105_000_000_000);
});

test('TC Fee Dash ingestion builds zero-fee fallback rows from Midgard', () => {
  const cmcVolumesByDate = new Map([[
    '2026-05-16',
    {
      cmcVolume24hUsd: 100_000_000_000,
      raw: { timestamp: '2026-05-16T00:00:00.000Z' }
    }
  ]]);
  const dexVolumesByDate = new Map([[
    '2026-05-16',
    {
      dexVolumeUsd: 7_000_000_000,
      raw: [1778889600, 7_000_000_000]
    }
  ]]);
  const rows = buildTcFeeDailyRowsFromMidgard([{
    startTime: '1778889600',
    endTime: '1778976000',
    liquidityFees: '0'
  }], [{
    startTime: '1778889600',
    endTime: '1778976000',
    runePriceUSD: '0.585620855154257'
  }], {
    cmcVolumesByDate,
    dexVolumesByDate
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].window_start, '2026-05-16');
  assert.equal(rows[0].tc_fees_rune, 0);
  assert.equal(rows[0].tc_fees_usd, 0);
  assert.equal(rows[0].defillama_dex_volume_usd, 7_000_000_000);
  assert.equal(rows[0].source_json.denominatorBasis, 'CMC historical global volume plus DeFiLlama DEX volume');
});

test('TC Fee Dash ingestion fills missing Dune days from fallback rows', () => {
  const primaryRows = [{
    window_start: '2026-05-15',
    tc_fees_usd: 5631.69
  }];
  const fallbackRows = [{
    window_start: '2026-05-16',
    tc_fees_usd: 0
  }];
  const merged = mergeTcFeeRowsForDays(['2026-05-15', '2026-05-16'], primaryRows, fallbackRows);

  assert.deepEqual(merged.primaryMissingDays, ['2026-05-16']);
  assert.deepEqual(merged.missingDays, []);
  assert.deepEqual(merged.rows.map((row) => row.window_start), ['2026-05-15', '2026-05-16']);
});

test('TC Fee Dash CMC parser accepts public historical global metrics shape', () => {
  const parsed = parseCmcGlobalVolumeDays({
    data: {
      quotes: [{
        timestamp: '2022-06-22T00:00:00.000Z',
        quote: {
          USD: {
            total_volume_24h: '987654321000'
          }
        }
      }]
    }
  });

  assert.equal(parsed.size, 1);
  assert.equal(parsed.get('2022-06-22').cmcVolume24hUsd, 987_654_321_000);
});

test('TC Fee Dash DeFiLlama parser accepts total data chart shape', () => {
  const parsed = parseDefiLlamaDexVolumeDays({
    totalDataChart: [
      [1778889600, 7_000_000_000]
    ]
  });

  assert.equal(parsed.size, 1);
  assert.equal(parsed.get('2026-05-16').dexVolumeUsd, 7_000_000_000);
});
