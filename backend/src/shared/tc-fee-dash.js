import { safeNumber } from '../lib/utils.js';

const BILLION = 1_000_000_000;
const BASIS_POINTS = 10_000;

function toDateKey(value) {
  if (!value) return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

export function computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd) {
  const fees = safeNumber(tcFeesUsd);
  const volume = safeNumber(globalExchangeVolumeUsd);
  return fees > 0 && volume > 0 ? (fees / volume) * BILLION : 0;
}

export function computeIncomeVolumeBps(incomeUsd, thorchainVolumeUsd) {
  const income = safeNumber(incomeUsd);
  const volume = safeNumber(thorchainVolumeUsd);
  return income >= 0 && volume > 0 ? (income / volume) * BASIS_POINTS : null;
}

export function normalizeTcFeeDashRow(row) {
  const tcFeesUsd = safeNumber(row.tc_fees_usd);
  const globalExchangeVolumeUsd = safeNumber(row.global_exchange_volume_usd);
  const thorchainVolumeUsd = row.thorchain_volume_usd == null
    ? null
    : safeNumber(row.thorchain_volume_usd);
  return {
    id: String(row.id || ''),
    period: String(row.period || ''),
    windowStart: toDateKey(row.window_start),
    windowEnd: toDateKey(row.window_end),
    windowLabel: String(row.window_label || ''),
    feeBps: safeNumber(row.fee_bps),
    tcFeesRune: safeNumber(row.tc_fees_rune),
    runePriceUsd: safeNumber(row.rune_price_usd),
    tcFeesUsd,
    cmcVolume24hUsd: safeNumber(row.cmc_volume_24h_usd),
    defillamaDexVolumeUsd: safeNumber(row.defillama_dex_volume_usd),
    globalExchangeVolumeUsd,
    thorchainVolumeUsd,
    feesPerBillionUsd: computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd),
    incomeVolumeBps: computeIncomeVolumeBps(tcFeesUsd, thorchainVolumeUsd),
    dailyMedianFeesPerBillionUsd: safeNumber(row.daily_median_fees_per_billion_usd),
    dailyRangeLowFeesPerBillionUsd: safeNumber(row.daily_range_low_fees_per_billion_usd),
    dailyRangeHighFeesPerBillionUsd: safeNumber(row.daily_range_high_fees_per_billion_usd),
    sourceLabel: String(row.source_label || ''),
    sourceThread: String(row.source_thread || '')
  };
}

export function summarizeTcFeeDashRows(rows) {
  if (!rows.length) {
    return {
      windowCount: 0,
      totalTcFeesUsd: 0,
      totalGlobalExchangeVolumeUsd: 0,
      totalThorchainVolumeUsd: 0,
      weightedFeesPerBillionUsd: 0,
      weightedIncomeVolumeBps: null,
      latest: null,
      peak: null
    };
  }

  const totalTcFeesUsd = rows.reduce((sum, row) => sum + row.tcFeesUsd, 0);
  const totalGlobalExchangeVolumeUsd = rows.reduce(
    (sum, row) => sum + row.globalExchangeVolumeUsd,
    0
  );
  const totalThorchainVolumeUsd = rows.reduce(
    (sum, row) => sum + row.thorchainVolumeUsd,
    0
  );
  const peak = rows.reduce((best, row) => (
    row.feesPerBillionUsd > best.feesPerBillionUsd ? row : best
  ), rows[0]);

  return {
    windowCount: rows.length,
    totalTcFeesUsd,
    totalGlobalExchangeVolumeUsd,
    totalThorchainVolumeUsd,
    weightedFeesPerBillionUsd: computeFeesPerBillionUsd(
      totalTcFeesUsd,
      totalGlobalExchangeVolumeUsd
    ),
    weightedIncomeVolumeBps: computeIncomeVolumeBps(
      totalTcFeesUsd,
      totalThorchainVolumeUsd
    ),
    latest: rows.at(-1),
    peak
  };
}

export async function buildTcFeeDashPayload(client, options = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('TC Fee Dash payload builder requires a database client');
  }
  const result = await client.query(
    `with selected_period as (
       select case
                when exists (
                  select 1
                  from tc_fee_dash_sync_state
                  where sync_key = 'daily' and complete = true
                )
                and exists (select 1 from tc_fee_dash_windows where period = 'day')
                  then 'day'
                else 'weekly_seed'
              end as period
     )
     select id, period, window_start, window_end, window_label, fee_bps,
            tc_fees_rune, rune_price_usd, tc_fees_usd,
            cmc_volume_24h_usd, defillama_dex_volume_usd,
            global_exchange_volume_usd, thorchain_volume_usd,
            daily_median_fees_per_billion_usd,
            daily_range_low_fees_per_billion_usd,
            daily_range_high_fees_per_billion_usd,
            source_label, source_thread, updated_at
     from tc_fee_dash_windows
     where period = (select period from selected_period)
     order by window_start asc, window_end asc`
  );
  const rows = result.rows.map(normalizeTcFeeDashRow);
  const period = rows[0]?.period || 'weekly_seed';
  const sourceUpdatedAt = result.rows.reduce((latest, row) => {
    const value = Date.parse(row.updated_at || '');
    return Number.isFinite(value) && value > latest ? value : latest;
  }, 0);
  const updatedAt = options.generatedAt || new Date().toISOString();
  return {
    payload: {
      meta: {
        source: 'boonetools-postgres',
        metric: period === 'day'
          ? 'tc_fees_per_billion_cmc_plus_dune_exchange_volume'
          : 'tc_fees_per_billion_global_exchange_volume',
        period,
        volumeScope: period === 'day'
          ? 'CMC historical global volume plus Dune indexed DEX exchange volume'
          : 'Global exchange volume, CEX plus DEX',
        incomeVolumeScope: 'Midgard liquidity fees divided by Midgard THORChain swap volume',
        updatedAt,
        ...summarizeTcFeeDashRows(rows)
      },
      rows
    },
    generatedAt: updatedAt,
    sourceUpdatedAt: sourceUpdatedAt > 0 ? new Date(sourceUpdatedAt).toISOString() : null,
    stats: {
      period,
      rows: rows.length
    }
  };
}
