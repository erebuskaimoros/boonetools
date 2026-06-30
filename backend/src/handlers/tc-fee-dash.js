import { query } from '../db/pool.js';
import { json } from '../lib/http.js';
import {
  normalizeTcFeeDashRow,
  summarizeTcFeeDashRows
} from '../shared/tc-fee-dash.js';

export async function handleTcFeeDash() {
  const result = await query(
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
            global_exchange_volume_usd,
            daily_median_fees_per_billion_usd,
            daily_range_low_fees_per_billion_usd,
            daily_range_high_fees_per_billion_usd,
            source_label, source_thread
     from tc_fee_dash_windows
     where period = (select period from selected_period)
     order by window_start asc, window_end asc`
  );

  const rows = result.rows.map(normalizeTcFeeDashRow);
  const period = rows[0]?.period || 'weekly_seed';
  return json({
    meta: {
      source: 'boonetools-postgres',
      metric: period === 'day'
        ? 'tc_fees_per_billion_cmc_plus_dune_exchange_volume'
        : 'tc_fees_per_billion_global_exchange_volume',
      period,
      volumeScope: period === 'day'
        ? 'CMC historical global volume plus Dune indexed DEX exchange volume'
        : 'Global exchange volume, CEX plus DEX',
      updatedAt: new Date().toISOString(),
      ...summarizeTcFeeDashRows(rows)
    },
    rows
  });
}
