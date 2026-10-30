import { safeNumber } from '../lib/utils.js';
import { buildTcFeeComposition } from './tc-fee-composition.js';
import {
  computeFeesPerBillionUsd,
  computeIncomeVolumeBps,
  summarizeTcFeeRows
} from '../../../shared/tc-fee-dash.js';

function toDateKey(value) {
  if (!value) return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
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
            source_label, source_thread, updated_at,
            source_json->'midgard'->'pools' as earnings_pools
     from tc_fee_dash_windows
     where period = (select period from selected_period)
     order by window_start asc, window_end asc`
  );
  const rows = result.rows.map(normalizeTcFeeDashRow);
  const updatedAt = options.generatedAt || new Date().toISOString();
  const composition = await buildTcFeeComposition(client, result.rows, { now: Date.parse(updatedAt) });
  const period = rows[0]?.period || 'weekly_seed';
  const sourceUpdatedAt = result.rows.reduce((latest, row) => {
    const value = Date.parse(row.updated_at || '');
    return Number.isFinite(value) && value > latest ? value : latest;
  }, Date.parse(composition.sourceUpdatedAt) || 0);
  return {
    payload: {
      meta: {
        source: 'boonetools-postgres',
        metric: period === 'day'
          ? 'tc_fees_per_billion_cmc_plus_dune_exchange_volume'
          : 'tc_fees_per_billion_global_exchange_volume',
        period,
        volumeScope: period === 'day'
          ? 'CMC historical global volume plus indexed DEX exchange volume'
          : 'Global exchange volume, CEX plus DEX',
        thorchainVolumeBasis: 'executed-leg-usd',
        incomeVolumeScope: 'Midgard liquidity fees divided by Midgard THORChain executed-leg swap volume',
        updatedAt,
        ...summarizeTcFeeRows(rows)
      },
      rows,
      feeComposition: {
        rows: composition.rows,
        scope: 'Pool-generated liquidity fees; excludes block rewards and downstream distributions',
        weighting: 'Historical USD fees; ratios are recomputed from sums, never averaged',
        coverage: 'Only complete pool breakdowns reconciled to the daily TC fee total are shown'
      }
    },
    generatedAt: updatedAt,
    sourceUpdatedAt: sourceUpdatedAt > 0 ? new Date(sourceUpdatedAt).toISOString() : null,
    stats: {
      period,
      rows: rows.length
    }
  };
}
