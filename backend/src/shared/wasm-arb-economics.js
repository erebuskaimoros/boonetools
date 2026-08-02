import { config } from '../lib/config.js';
import { safeNumber } from '../lib/utils.js';
import {
  BASE_LAYER_COLLECTOR,
  RUJIRA_TRADE_COLLECTOR,
  WASM_ARB_CONTRACT
} from './wasm-arb-economics-ingestion.js';
import { compactWasmArbMonitoringRows } from '../../../shared/wasm-arb-economics/model.js';

const FALLBACK_SERIES_DAYS = 30;
const BUCKET_SECONDS = 300;
const RECENT_DETAIL_SECONDS = 30 * 24 * 60 * 60;
const RECENT_GRAIN_SECONDS = 60 * 60;
const HISTORICAL_GRAIN_SECONDS = 24 * 60 * 60;

function iso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeRegime(row) {
  return {
    activationHeight: safeNumber(row.activation_height),
    activationTime: iso(row.activation_time),
    mimirValue: safeNumber(row.mimir_value),
    previousMimirValue: row.previous_mimir_value == null
      ? null
      : safeNumber(row.previous_mimir_value),
    spreadBps: row.spread_bps == null ? null : safeNumber(row.spread_bps),
    previousSpreadBps: row.previous_spread_bps == null
      ? null
      : safeNumber(row.previous_spread_bps),
    arbContract: String(row.arb_contract || ''),
    tradeCollector: String(row.trade_collector || ''),
    baseLayerCollector: String(row.base_layer_collector || ''),
    tcShare: safeNumber(row.tc_share, 0.5),
    source: String(row.source || ''),
    observedAt: iso(row.observed_at),
    metadata: row.metadata_json || {},
    changeKind: String(row.metadata_json?.change_kind || '')
  };
}

function regimeForTime(regimes, value) {
  const timestamp = Date.parse(value || '');
  const active = [...regimes]
    .reverse()
    .find((regime) => Date.parse(regime.activationTime || '') <= timestamp);
  if (active) return active;
  const first = regimes[0];
  return first
    ? {
        ...first,
        mimirValue: first.previousMimirValue ?? first.mimirValue,
        previousMimirValue: first.previousMimirValue ?? first.mimirValue
      }
    : {
        mimirValue: 0,
        previousMimirValue: 0,
        tcShare: 0.5
      };
}

function rowMap(rows) {
  return new Map(rows.map((row) => [iso(row.bucket_start), row]));
}

function syncStateMap(rows) {
  return Object.fromEntries(rows.map((row) => [row.sync_key, {
    cursorValue: String(row.cursor_value || ''),
    complete: Boolean(row.complete),
    updatedAt: iso(row.updated_at),
    stats: row.stats_json || {}
  }]));
}

function isMimirRegime(regime) {
  return regime?.changeKind?.includes('mimir')
    || regime?.previousMimirValue == null
    || regime?.mimirValue !== regime?.previousMimirValue;
}

function isSpreadRegime(regime) {
  return regime?.changeKind?.includes('spread');
}

export async function buildWasmArbEconomicsPayload(client, options = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('Wasm arb economics payload builder requires a database client');
  }
  const generatedAt = options.generatedAt || new Date().toISOString();
  const fallbackStart = new Date(
    Date.parse(generatedAt) - FALLBACK_SERIES_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const regimeResult = await client.query(
    `select activation_height, activation_time, mimir_value, previous_mimir_value,
            spread_bps, previous_spread_bps,
            arb_contract, trade_collector, base_layer_collector, tc_share,
            source, observed_at, metadata_json
     from wasm_arb_economics_regimes
     order by activation_time asc`
  );
  const regimes = regimeResult.rows.map(normalizeRegime);
  const allInterventions = regimes.filter(
    (regime) => isMimirRegime(regime) || isSpreadRegime(regime)
  );
  const firstMimirRegime = regimes.find(isMimirRegime) || null;
  const trackingRegime = regimes.find((regime) => (
    isMimirRegime(regime)
      && regime.mimirValue === 0
      && regime.previousMimirValue !== 0
  )) || firstMimirRegime;
  const currentRegime = [...regimes].reverse().find(isMimirRegime)
    || regimes.at(-1)
    || null;
  const currentSpreadRegime = [...regimes].reverse().find(isSpreadRegime) || null;
  const currentIntervention = allInterventions.at(-1) || currentRegime;
  const trackingStart = options.since || trackingRegime?.activationTime || fallbackStart;
  const seriesParams = [trackingStart];
  const seriesPredicate = (column) => `${column} >= $1::timestamptz`;
  const trackingStartMs = Date.parse(trackingStart);
  const interventions = allInterventions.filter((regime) => (
    Date.parse(regime.activationTime || '') >= trackingStartMs
  ));

  const networkResult = await client.query(
    `select bucket_start, bucket_end, network_volume_usd,
            network_liquidity_fee_rune, network_liquidity_fee_usd,
            network_swap_leg_count, rune_price_usd, updated_at
     from wasm_arb_economics_network_buckets
     where ${seriesPredicate('bucket_start')}
     order by bucket_start asc`,
    seriesParams
  );
  const actionResult = await client.query(
    `with first_regime as (
           select coalesce(previous_mimir_value, mimir_value) as reference_value
           from wasm_arb_economics_regimes
           where coalesce(metadata_json->>'change_kind', 'mimir') like '%mimir%'
           order by activation_time asc
           limit 1
         ), action_base as (
           select action.*,
                  to_timestamp(floor(extract(epoch from action.block_time) / 300) * 300)
                    as bucket_start,
                  coalesce(
                    regime.previous_mimir_value,
                    (select reference_value from first_regime),
                    0
                  ) as reference_value
           from wasm_arb_economics_actions action
           left join lateral (
             select mimir_value, previous_mimir_value
             from wasm_arb_economics_regimes
             where activation_time <= action.block_time
               and coalesce(metadata_json->>'change_kind', 'mimir') like '%mimir%'
             order by activation_time desc
             limit 1
           ) regime on true
           where action.action_key like 'wasm-arb-action:v2:%'
             and (${seriesPredicate('action.block_time')})
         ), action_summary as (
           select bucket_start,
                count(*)::integer as wasm_action_count,
                sum(leg_count)::integer as wasm_leg_count,
                count(*) filter (where leg_count = 1)::integer as wasm_single_action_count,
                count(*) filter (where leg_count = 2)::integer as wasm_double_action_count,
                coalesce(sum(input_volume_usd), 0) as wasm_input_volume_usd,
                coalesce(sum(executed_leg_volume_usd), 0) as wasm_leg_volume_usd,
                coalesce(sum(liquidity_fee_rune), 0) as wasm_liquidity_fee_rune,
                count(*) filter (where swap_slip_bps = 0)::integer
                  as zero_slip_action_count,
                count(*) filter (where liquidity_fee_rune = 0)::integer
                  as zero_fee_action_count,
                count(*) filter (where swap_slip_bps < reference_value)::integer
                  as below_reference_action_count,
                percentile_disc(0.5) within group (order by swap_slip_bps)
                  as median_slip_bps,
                percentile_disc(0.9) within group (order by swap_slip_bps)
                  as p90_slip_bps,
                max(swap_slip_bps) as max_slip_bps
           from action_base
           group by bucket_start
         ), slip_counts as (
           select bucket_start, swap_slip_bps, count(*)::integer as action_count
           from action_base
           group by bucket_start, swap_slip_bps
         ), slip_histograms as (
           select bucket_start,
                  jsonb_object_agg(swap_slip_bps::text, action_count order by swap_slip_bps)
                    as slip_histogram
           from slip_counts
           group by bucket_start
         )
         select summary.*, histogram.slip_histogram
         from action_summary summary
         join slip_histograms histogram using (bucket_start)
     order by summary.bucket_start asc`,
    seriesParams
  );
  const feeResult = await client.query(
    `select to_timestamp(floor(extract(epoch from block_time) / 300) * 300)
                  as bucket_start,
                count(*)::integer as rujira_fee_event_count,
                count(*) filter (where fee_usd is null)::integer
                  as unpriced_rujira_fee_event_count,
                coalesce(sum(fee_usd) filter (where fee_kind = 'amm'), 0) as amm_fee_usd,
                coalesce(sum(fee_usd) filter (where fee_kind in ('fin', 'fin_range')), 0)
                  as fin_fee_usd,
                coalesce(sum(fee_usd) filter (where fee_kind = 'fin_range'), 0)
                  as fin_range_fee_usd,
                coalesce(sum(fee_usd) filter (
                  where wasm_linked and fee_kind = 'amm'
                ), 0) as linked_amm_fee_usd,
                coalesce(sum(fee_usd) filter (
                  where wasm_linked and fee_kind in ('fin', 'fin_range')
                ), 0) as linked_fin_fee_usd,
                coalesce(sum(fee_usd) filter (
                  where wasm_linked and fee_kind = 'fin_range'
                ), 0) as linked_fin_range_fee_usd
         from wasm_arb_economics_rujira_fees
         where event_key like 'wasm-arb-rujira-fee:v2:%'
           and (${seriesPredicate('block_time')})
         group by 1
     order by 1 asc`,
    seriesParams
  );
  const oracleResult = await client.query(
    `select to_timestamp(floor(extract(epoch from block_time) / 300) * 300)
                  as bucket_start,
                count(*)::integer as oracle_observation_count,
                coalesce(sum(absolute_deviation_bps), 0) as oracle_abs_deviation_sum_bps,
                coalesce(sum(signed_deviation_bps), 0) as oracle_signed_deviation_sum_bps,
                coalesce(sum(absolute_deviation_bps * rune_depth_usd), 0)
                  as oracle_weighted_abs_numerator,
                coalesce(sum(rune_depth_usd), 0) as oracle_depth_weight_usd,
                count(*) filter (where absolute_deviation_bps <= 10)::integer
                  as oracle_within_10_count,
                count(*) filter (where absolute_deviation_bps <= 25)::integer
                  as oracle_within_25_count,
                coalesce(max(absolute_deviation_bps), 0) as oracle_max_abs_deviation_bps,
                count(*) filter (where oracle_symbol <> 'LTC')::integer
                  as oracle_ex_ltc_observation_count,
                coalesce(sum(absolute_deviation_bps) filter (where oracle_symbol <> 'LTC'), 0)
                  as oracle_ex_ltc_abs_deviation_sum_bps,
                coalesce(sum(signed_deviation_bps) filter (where oracle_symbol <> 'LTC'), 0)
                  as oracle_ex_ltc_signed_deviation_sum_bps,
                coalesce(sum(absolute_deviation_bps * rune_depth_usd)
                  filter (where oracle_symbol <> 'LTC'), 0)
                  as oracle_ex_ltc_weighted_abs_numerator,
                coalesce(sum(rune_depth_usd) filter (where oracle_symbol <> 'LTC'), 0)
                  as oracle_ex_ltc_depth_weight_usd,
                count(*) filter (
                  where oracle_symbol <> 'LTC' and absolute_deviation_bps <= 10
                )::integer as oracle_ex_ltc_within_10_count,
                count(*) filter (
                  where oracle_symbol <> 'LTC' and absolute_deviation_bps <= 25
                )::integer as oracle_ex_ltc_within_25_count,
                coalesce(max(absolute_deviation_bps) filter (where oracle_symbol <> 'LTC'), 0)
                  as oracle_ex_ltc_max_abs_deviation_bps
         from wasm_arb_economics_oracle_samples
         where ${seriesPredicate('block_time')}
         group by 1
     order by 1 asc`,
    seriesParams
  );
  const stateResult = await client.query(
    `select sync_key, cursor_value, complete, stats_json, updated_at
     from wasm_arb_economics_sync_state
     order by sync_key`
  );
  const blockResult = await client.query(
    `select count(*) filter (
              where status in ('pending', 'error') or fetched_version < 2
            )::integer as pending,
            count(*) filter (
              where status = 'fetched' and fetched_version >= 2
            )::integer as fetched,
            min(height) filter (
              where status in ('pending', 'error') or fetched_version < 2
            ) as oldest_pending_height,
            max(height) filter (
              where status = 'fetched' and fetched_version >= 2
            ) as latest_fetched_height,
            max(fetched_at) filter (where fetched_version >= 2) as latest_fetched_at
     from wasm_arb_economics_blocks
     where scan_version >= 2
       and height >= $1`,
    [trackingRegime?.activationHeight || config.wasmArbEconomicsStartHeight]
  );
  const jobResult = await client.query(
    `select finished_at, stats_json
     from wasm_arb_economics_job_runs
     where status = 'success'
     order by finished_at desc
     limit 1`
  );

  const actions = rowMap(actionResult.rows);
  const fees = rowMap(feeResult.rows);
  const oracle = rowMap(oracleResult.rows);
  const sync = syncStateMap(stateResult.rows);
  const actionBackfillComplete = Boolean(sync['actions-backfill:arb:v2']?.complete);
  const pendingBlocks = safeNumber(blockResult.rows[0]?.pending);
  const feeBackfillComplete = Boolean(sync['collector-tx-search-backfill']?.complete)
    && Boolean(sync['collector-block-search-backfill']?.complete)
    && pendingBlocks === 0;
  const oracleBackfillComplete = Boolean(sync['oracle:backfill']?.complete);

  const sourceRows = networkResult.rows.map((network) => {
    const bucketStart = iso(network.bucket_start);
    const action = actions.get(bucketStart) || {};
    const fee = fees.get(bucketStart) || {};
    const oracleRow = oracle.get(bucketStart) || {};
    const regime = regimeForTime(regimes, bucketStart);
    const mimirRegime = regimeForTime(regimes.filter(isMimirRegime), bucketStart);
    const runePriceUsd = safeNumber(network.rune_price_usd);
    const wasmLiquidityFeeRune = safeNumber(action.wasm_liquidity_fee_rune);
    return {
      bucketStart,
      bucketSeconds: BUCKET_SECONDS,
      networkVolumeUsd: safeNumber(network.network_volume_usd),
      networkLiquidityFeeRune: safeNumber(network.network_liquidity_fee_rune),
      networkLiquidityFeeUsd: safeNumber(network.network_liquidity_fee_usd),
      networkSwapLegCount: safeNumber(network.network_swap_leg_count),
      runePriceUsd,
      wasmActionCount: safeNumber(action.wasm_action_count),
      wasmLegCount: safeNumber(action.wasm_leg_count),
      wasmSingleActionCount: safeNumber(action.wasm_single_action_count),
      wasmDoubleActionCount: safeNumber(action.wasm_double_action_count),
      wasmInputVolumeUsd: safeNumber(action.wasm_input_volume_usd),
      wasmLegVolumeUsd: safeNumber(action.wasm_leg_volume_usd),
      wasmLiquidityFeeRune,
      wasmLiquidityFeeUsd: wasmLiquidityFeeRune * runePriceUsd,
      zeroSlipActionCount: safeNumber(action.zero_slip_action_count),
      zeroFeeActionCount: safeNumber(action.zero_fee_action_count),
      belowReferenceActionCount: safeNumber(action.below_reference_action_count),
      slipHistogram: action.slip_histogram || {},
      medianSlipBps: action.median_slip_bps == null ? null : safeNumber(action.median_slip_bps),
      p90SlipBps: action.p90_slip_bps == null ? null : safeNumber(action.p90_slip_bps),
      maxSlipBps: action.max_slip_bps == null ? null : safeNumber(action.max_slip_bps),
      ammFeeUsd: safeNumber(fee.amm_fee_usd),
      finFeeUsd: safeNumber(fee.fin_fee_usd),
      finRangeFeeUsd: safeNumber(fee.fin_range_fee_usd),
      linkedAmmFeeUsd: safeNumber(fee.linked_amm_fee_usd),
      linkedFinFeeUsd: safeNumber(fee.linked_fin_fee_usd),
      linkedFinRangeFeeUsd: safeNumber(fee.linked_fin_range_fee_usd),
      rujiraFeeEventCount: safeNumber(fee.rujira_fee_event_count),
      unpricedRujiraFeeEventCount: safeNumber(fee.unpriced_rujira_fee_event_count),
      oracleObservationCount: safeNumber(oracleRow.oracle_observation_count),
      oracleAbsDeviationSumBps: safeNumber(oracleRow.oracle_abs_deviation_sum_bps),
      oracleSignedDeviationSumBps: safeNumber(oracleRow.oracle_signed_deviation_sum_bps),
      oracleWeightedAbsNumerator: safeNumber(oracleRow.oracle_weighted_abs_numerator),
      oracleDepthWeightUsd: safeNumber(oracleRow.oracle_depth_weight_usd),
      oracleWithin10Count: safeNumber(oracleRow.oracle_within_10_count),
      oracleWithin25Count: safeNumber(oracleRow.oracle_within_25_count),
      oracleMaxAbsDeviationBps: safeNumber(oracleRow.oracle_max_abs_deviation_bps),
      oracleExLtcObservationCount: safeNumber(oracleRow.oracle_ex_ltc_observation_count),
      oracleExLtcAbsDeviationSumBps: safeNumber(
        oracleRow.oracle_ex_ltc_abs_deviation_sum_bps
      ),
      oracleExLtcSignedDeviationSumBps: safeNumber(
        oracleRow.oracle_ex_ltc_signed_deviation_sum_bps
      ),
      oracleExLtcWeightedAbsNumerator: safeNumber(
        oracleRow.oracle_ex_ltc_weighted_abs_numerator
      ),
      oracleExLtcDepthWeightUsd: safeNumber(oracleRow.oracle_ex_ltc_depth_weight_usd),
      oracleExLtcWithin10Count: safeNumber(oracleRow.oracle_ex_ltc_within_10_count),
      oracleExLtcWithin25Count: safeNumber(oracleRow.oracle_ex_ltc_within_25_count),
      oracleExLtcMaxAbsDeviationBps: safeNumber(
        oracleRow.oracle_ex_ltc_max_abs_deviation_bps
      ),
      tcShare: regime.tcShare,
      mimirValue: mimirRegime.mimirValue,
      referenceMimirValue: mimirRegime.previousMimirValue ?? mimirRegime.mimirValue,
      networkComplete: true,
      actionsComplete: actionBackfillComplete,
      feesComplete: feeBackfillComplete,
      oracleComplete: oracleBackfillComplete
    };
  });
  const compacted = compactWasmArbMonitoringRows(sourceRows, {
    recentSeconds: RECENT_DETAIL_SECONDS,
    recentGrainSeconds: RECENT_GRAIN_SECONDS,
    historicalGrainSeconds: HISTORICAL_GRAIN_SECONDS
  });
  const rows = compacted.rows;

  const blockCoverage = blockResult.rows[0] || {};
  const latestJob = jobResult.rows[0] || {};
  const sourceUpdatedAt = [
    networkResult.rows.at(-1)?.bucket_end,
    oracleResult.rows.at(-1)?.bucket_start,
    blockCoverage.latest_fetched_at,
    latestJob.finished_at
  ].map((value) => Date.parse(value || '')).filter(Number.isFinite).reduce(
    (latest, value) => Math.max(latest, value),
    0
  );
  const finContractCount = safeNumber(latestJob.stats_json?.blocks?.finContracts);

  return {
    payload: {
      schemaVersion: 3,
      meta: {
        source: 'boonetools-postgres',
        generatedAt,
        sourceUpdatedAt: sourceUpdatedAt > 0 ? new Date(sourceUpdatedAt).toISOString() : null,
        sourceBucketSeconds: BUCKET_SECONDS,
        trackingStart,
        trackingRegime,
        seriesMode: 'post-mimir-zero',
        seriesResolution: {
          recentStart: compacted.recentStart,
          recentBucketSeconds: compacted.recentGrainSeconds,
          historicalBucketSeconds: compacted.historicalGrainSeconds
        },
        volumeBasis: 'executed-leg-usd',
        currentRegime,
        currentSpreadRegime,
        currentIntervention,
        interventions,
        contracts: {
          wasmArb: WASM_ARB_CONTRACT,
          rujiraTradeCollector: RUJIRA_TRADE_COLLECTOR,
          baseLayerCollector: BASE_LAYER_COLLECTOR,
          finCodeIds: [...(options.finCodeIds || config.wasmArbEconomicsFinCodeIds)],
          finContractCount
        },
        coverage: {
          networkComplete: Boolean(sync['network:5min']?.complete),
          actionBackfillComplete,
          feeBackfillComplete,
          oracleBackfillComplete,
          collectorTxSearchComplete: Boolean(sync['collector-tx-search-backfill']?.complete),
          collectorBlockSearchComplete: Boolean(
            sync['collector-block-search-backfill']?.complete
          ),
          pendingBlocks,
          fetchedBlocks: safeNumber(blockCoverage.fetched),
          oldestPendingHeight: blockCoverage.oldest_pending_height == null
            ? null
            : safeNumber(blockCoverage.oldest_pending_height),
          latestFetchedHeight: blockCoverage.latest_fetched_height == null
            ? null
            : safeNumber(blockCoverage.latest_fetched_height),
          sync
        },
        methodology: {
          network: 'Midgard five-minute swap history; USD values are converted from e2 fields.',
          series: 'The public series starts when WasmArbSlipMinBps changed to zero. Recent source buckets are compacted hourly and older history daily.',
          wasm: 'Successful Midgard swaps whose inbound address is the configured WasmArbContract.',
          volume: 'Executed-leg USD: one leg for RUNE routes and both legs for asset-to-asset routes, after collapsing identical duplicate outbound records inside an action.',
          thorFees: 'Midgard action liquidityFee in base RUNE, priced with the matching five-minute RUNE price.',
          rujiraFees: 'Actual bank transfers from every configured FIN code deployment and the Wasm arb contract to the RUJI Trade collector; tx_search and block_search independently discover transaction and finalize-block recipients.',
          linked: 'A FIN transfer is Wasm-linked only when the same transaction executes the configured Wasm arb contract.',
          tcAllocation: 'Economic accrual uses the observed Base Layer collector target weight; it is not same-window Reserve settlement.',
          finRange: 'FIN range fees are a subset of total FIN fees and are matched to rujira-fin/range.fee event amounts.',
          pricing: 'RUNE, stable, and Midgard historical prices are supplemented by the same-context FIN execution rate when a fee denom has no direct historical pool price.',
          oracle: 'Pool balance-ratio prices and THORChain oracle prices are sampled at the same historical height for the 12 comparable Wasm-path pools; depth weighting uses USD RUNE-side depth.',
          exclusions: 'Pool/oracle tracking is reported separately; LVR and arbitrage profit are not included in the TC cash-flow verdict.'
        }
      },
      regimes,
      rows
    },
    generatedAt,
    sourceUpdatedAt: sourceUpdatedAt > 0 ? new Date(sourceUpdatedAt).toISOString() : null,
    stats: {
      rows: rows.length,
      source_rows: compacted.sourceRowCount,
      recent_rows: compacted.recentRowCount,
      historical_rows: compacted.historicalRowCount,
      regimes: regimes.length,
      pending_blocks: pendingBlocks,
      action_backfill_complete: actionBackfillComplete,
      fee_backfill_complete: feeBackfillComplete,
      oracle_backfill_complete: oracleBackfillComplete
    }
  };
}
