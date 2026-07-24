import { query } from '../db/pool.js';
import { safeNumber, toIsoString } from '../lib/utils.js';
import {
  getRapidSwapLegVolumeUsd,
  getRapidSwapRouteVolumeUsd,
  RAPID_SWAP_VOLUME_BASIS
} from '../../../shared/rapid-swaps/volume.js';

export const RAPID_SWAP_COLUMNS = [
  'tx_id', 'action_height', 'action_date', 'observed_at', 'memo', 'tx_status',
  'source_asset', 'target_asset', 'input_amount_base', 'output_amount_base',
  'input_estimated_usd', 'output_estimated_usd', 'comparable_volume_usd',
  'liquidity_fee_base', 'swap_slip_bps', 'is_limit_order', 'streaming_interval',
  'streaming_quantity', 'streaming_count', 'blocks_used', 'affiliate',
  'source_address', 'destination_address'
].join(', ');

const MAX_RECENT_ROWS = 100;

export function normalizeRapidSwapDashboardRow(row) {
  return {
    tx_id: String(row.tx_id || ''),
    action_height: Number(row.action_height) || 0,
    action_date: toIsoString(row.action_date),
    observed_at: toIsoString(row.observed_at),
    memo: String(row.memo || ''),
    tx_status: String(row.tx_status || ''),
    source_asset: String(row.source_asset || ''),
    target_asset: String(row.target_asset || ''),
    input_amount_base: String(row.input_amount_base || '0'),
    output_amount_base: String(row.output_amount_base || '0'),
    input_estimated_usd: Number(row.input_estimated_usd) || 0,
    output_estimated_usd: Number(row.output_estimated_usd) || 0,
    leg_volume_usd: getRapidSwapLegVolumeUsd(row),
    route_volume_usd: getRapidSwapRouteVolumeUsd(row),
    // Retained for clients that predate the explicit volume contract.
    comparable_volume_usd: getRapidSwapLegVolumeUsd(row),
    liquidity_fee_base: String(row.liquidity_fee_base || '0'),
    swap_slip_bps: Number(row.swap_slip_bps) || 0,
    is_limit_order: Boolean(row.is_limit_order),
    streaming_interval: Number(row.streaming_interval) || 0,
    streaming_quantity: Number(row.streaming_quantity) || 0,
    streaming_count: Number(row.streaming_count) || 0,
    blocks_used: Number(row.blocks_used) || 0,
    affiliate: String(row.affiliate || ''),
    source_address: String(row.source_address || ''),
    destination_address: String(row.destination_address || '')
  };
}

function roundUsd(value) {
  return Math.round(safeNumber(value, 0) * 100) / 100;
}

function normalizeDailyBuckets(rows) {
  let cumulativeCount = 0;
  let cumulativeVolumeUsd = 0;
  return rows.map((row) => {
    const swapCount = Number(row.swap_count) || 0;
    const legVolumeUsd = roundUsd(row.comparable_volume_usd);
    cumulativeCount += swapCount;
    cumulativeVolumeUsd += legVolumeUsd;
    return {
      bucket_start: toIsoString(row.bucket_start),
      swap_count: swapCount,
      leg_volume_usd: legVolumeUsd,
      comparable_volume_usd: legVolumeUsd,
      total_subs: Number(row.total_subs) || 0,
      total_blocks_used: Number(row.total_blocks_used) || 0,
      saved_blocks: Number(row.saved_blocks) || 0,
      cumulative_count: cumulativeCount,
      cumulative_leg_volume_usd: roundUsd(cumulativeVolumeUsd),
      cumulative_volume_usd: roundUsd(cumulativeVolumeUsd)
    };
  });
}

export function selectRapidSwapChartBuckets(buckets, range = {}) {
  const fromMs = Number(range.from || 0) * 1000;
  const toMs = Number(range.to || 0) * 1000;
  if (!(fromMs > 0 && toMs > fromMs)) {
    return {
      buckets: [],
      rowCount: 0,
      cumulativeCountBefore: 0,
      cumulativeVolumeBefore: 0
    };
  }

  const source = Array.isArray(buckets) ? buckets : [];
  const before = source.filter((bucket) => Date.parse(bucket.bucket_start || '') < fromMs).at(-1);
  const selected = source.filter((bucket) => {
    const time = Date.parse(bucket.bucket_start || '');
    return Number.isFinite(time) && time >= fromMs && time < toMs;
  });
  return {
    buckets: selected,
    rowCount: selected.reduce((sum, bucket) => sum + (Number(bucket.swap_count) || 0), 0),
    cumulativeCountBefore: Number(before?.cumulative_count) || 0,
    cumulativeVolumeBefore: roundUsd(
      before?.cumulative_leg_volume_usd ?? before?.cumulative_volume_usd
    )
  };
}

export async function buildRapidSwapsSummaryPayload(client = { query }, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const recentWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [
    summaryResult,
    topRowsResult,
    latestRowsResult,
    recentRowsResult,
    dailyBucketsResult,
    distributionsResult,
    affiliatesResult,
    pathsResult,
    lastRunResult,
    wsListenerResult,
    pendingCandidatesResult,
    syncStateResult
  ] = await Promise.all([
    client.query(
      `select min(observed_at) as tracker_started_at,
              count(*)::bigint as total_tracked,
              coalesce(sum(comparable_volume_usd), 0) as cumulative_volume_usd,
              coalesce(sum(greatest(coalesce(streaming_count, 1), 1)), 0) as total_subs,
              coalesce(sum(greatest(coalesce(blocks_used, 1), 1)), 0) as total_blocks_used,
              coalesce(sum(greatest(greatest(coalesce(streaming_count, 1), 1) - greatest(coalesce(blocks_used, 1), 1), 0)), 0) as saved_blocks,
              count(*) filter (where action_date >= $1)::bigint as recent_24h_count,
              coalesce(sum(comparable_volume_usd) filter (where action_date >= $1), 0) as recent_24h_volume_usd
       from rapid_swaps`,
      [recentWindowStart]
    ),
    client.query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       order by comparable_volume_usd desc, action_date desc
       limit 20`
    ),
    client.query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       order by action_date desc, tx_id asc
       limit 20`
    ),
    client.query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       where action_date >= $1
       order by action_date desc
       limit $2`,
      [recentWindowStart, MAX_RECENT_ROWS]
    ),
    client.query(
      `select date_trunc('day', action_date at time zone 'UTC')::date as bucket_start,
              count(*)::bigint as swap_count,
              coalesce(sum(comparable_volume_usd), 0) as comparable_volume_usd,
              coalesce(sum(greatest(coalesce(streaming_count, 1), 1)), 0) as total_subs,
              coalesce(sum(greatest(coalesce(blocks_used, 1), 1)), 0) as total_blocks_used,
              coalesce(sum(greatest(greatest(coalesce(streaming_count, 1), 1) - greatest(coalesce(blocks_used, 1), 1), 0)), 0) as saved_blocks
       from rapid_swaps
       group by 1
       order by 1 asc`
    ),
    client.query(
      `select bucket.dimension, bucket.label, bucket.sort_order,
              count(*)::bigint as swap_count,
              coalesce(sum(swaps.comparable_volume_usd), 0) as volume_usd
       from rapid_swaps swaps
       cross join lateral (
         values
           ('sub_swaps',
            case
              when greatest(coalesce(swaps.streaming_count, 0), 0) <= 3 then '2-3'
              when swaps.streaming_count <= 5 then '4-5'
              when swaps.streaming_count <= 10 then '6-10'
              when swaps.streaming_count <= 20 then '11-20'
              else '21+'
            end,
            case
              when greatest(coalesce(swaps.streaming_count, 0), 0) <= 3 then 1
              when swaps.streaming_count <= 5 then 2
              when swaps.streaming_count <= 10 then 3
              when swaps.streaming_count <= 20 then 4
              else 5
            end),
           ('time_saved_seconds',
            case
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) = 0 then '0'
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) < 10 then '<1m'
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) < 50 then '1-5m'
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) < 150 then '5-15m'
              else '15m+'
            end,
            case
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) = 0 then 1
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) < 10 then 2
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) < 50 then 3
              when greatest(coalesce(swaps.streaming_count, 0) - coalesce(swaps.blocks_used, 0), 0) < 150 then 4
              else 5
            end)
       ) as bucket(dimension, label, sort_order)
       group by bucket.dimension, bucket.label, bucket.sort_order
       order by bucket.dimension, bucket.sort_order`
    ),
    client.query(
      `select affiliate,
              count(*)::bigint as swap_count,
              coalesce(sum(comparable_volume_usd), 0) as volume_usd
       from rapid_swaps
       where nullif(trim(affiliate), '') is not null
       group by affiliate
       order by volume_usd desc, swap_count desc, affiliate asc
       limit 100`
    ),
    client.query(
      `select source_asset, target_asset,
              count(*)::bigint as swap_count,
              coalesce(sum(comparable_volume_usd), 0) as volume_usd,
              coalesce(avg(greatest(coalesce(streaming_count, 0) - coalesce(blocks_used, 0), 0)), 0) as avg_saved_blocks,
              coalesce(avg(
                case when coalesce(streaming_count, 0) > 0 and coalesce(blocks_used, 0) > 0
                  then greatest(0, 1 - blocks_used::double precision / streaming_count::double precision)
                  else 0 end
              ), 0) * 100 as avg_pct_faster
       from rapid_swaps
       where nullif(source_asset, '') is not null and nullif(target_asset, '') is not null
       group by source_asset, target_asset
       order by volume_usd desc, swap_count desc, source_asset asc, target_asset asc
       limit 200`
    ),
    client.query(
      `select finished_at, status, stats_json
       from rapid_swap_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['rapid-swaps-recent-actions']
    ),
    client.query(
      `select finished_at, status, stats_json
       from rapid_swap_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['rapid-swaps-ws-listener']
    ),
    client.query(
      `select count(*)::bigint as count
       from rapid_swap_candidates
       where status = $1`,
      ['pending']
    ),
    client.query(
      `select last_scanned_height, last_scanned_at, stats_json
       from rapid_swap_sync_state
       where sync_key = $1
       limit 1`,
      ['rapid-swaps-canonical']
    )
  ]);

  const summary = summaryResult.rows[0] || {};
  const trackerStartedAt = summary.tracker_started_at || null;
  const lastRunAt = lastRunResult.rows[0]?.finished_at || null;
  const syncStats = syncStateResult.rows[0]?.stats_json || {};
  const lastRunStats = lastRunResult.rows[0]?.stats_json || {};
  const sourceStatus = syncStats.source_status || lastRunStats.source_status || null;
  const liveTailStats = syncStats.live_tail || lastRunStats.live_tail || null;
  const canonicalSource = {
    provider: syncStats.canonical_provider || lastRunStats.canonical_provider || (syncStats.dune_query_id || lastRunStats.dune_query_id ? 'dune' : ''),
    query_id: syncStats.dune_query_id || lastRunStats.dune_query_id || sourceStatus?.dune?.query_id || '',
    execution_id: syncStats.dune_execution_id || lastRunStats.dune_execution_id || sourceStatus?.dune?.execution_id || '',
    last_scanned_at: toIsoString(syncStats.dune_last_scanned_at || lastRunStats.dune_last_scanned_at || sourceStatus?.dune?.last_scanned_at),
    next_scan_at: toIsoString(syncStats.dune_next_scan_at || lastRunStats.dune_next_scan_at || sourceStatus?.dune?.next_scan_at),
    next_start_time: toIsoString(syncStats.dune_next_start_time || lastRunStats.dune_next_start_time || sourceStatus?.dune?.next_start_time),
    head_end_time: toIsoString(syncStats.dune_head_end_time || lastRunStats.dune_head_end_time || sourceStatus?.dune?.head_end_time)
  };
  const totalSubs = Number(summary.total_subs) || 0;
  const totalBlocksUsed = Number(summary.total_blocks_used) || 0;
  const blockTimeSeconds = 6;
  const baselineSeconds = totalSubs * blockTimeSeconds;
  const actualSeconds = totalBlocksUsed * blockTimeSeconds;
  const freshnessSeconds = lastRunAt
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(toIsoString(lastRunAt))) / 1000))
    : -1;

  const distributionRows = distributionsResult.rows.map((row) => ({
    dimension: String(row.dimension || ''),
    bucket: String(row.label || ''),
    sort_order: Number(row.sort_order) || 0,
    swap_count: Number(row.swap_count) || 0,
    leg_volume_usd: roundUsd(row.volume_usd),
    volume_usd: roundUsd(row.volume_usd)
  }));
  const paths = pathsResult.rows.map((row) => ({
    source_asset: String(row.source_asset || ''),
    target_asset: String(row.target_asset || ''),
    path: `${String(row.source_asset || '')} -> ${String(row.target_asset || '')}`,
    swap_count: Number(row.swap_count) || 0,
    leg_volume_usd: roundUsd(row.volume_usd),
    volume_usd: roundUsd(row.volume_usd),
    avg_saved_blocks: Number(row.avg_saved_blocks) || 0,
    avg_time_saved_seconds: (Number(row.avg_saved_blocks) || 0) * blockTimeSeconds,
    avg_pct_faster: Number(row.avg_pct_faster) || 0
  }));

  return {
    schema_version: 4,
    volume_basis: RAPID_SWAP_VOLUME_BASIS,
    as_of: now.toISOString(),
    tracker_started_at: toIsoString(trackerStartedAt),
    tracker_warmup_complete: trackerStartedAt
      ? now.getTime() - Date.parse(toIsoString(trackerStartedAt)) >= 24 * 60 * 60 * 1000
      : false,
    recent_window_started_at: recentWindowStart,
    total_tracked: Number(summary.total_tracked) || 0,
    cumulative_leg_volume_usd: roundUsd(summary.cumulative_volume_usd),
    cumulative_volume_usd: roundUsd(summary.cumulative_volume_usd),
    time_saved_seconds: (Number(summary.saved_blocks) || 0) * blockTimeSeconds,
    baseline_seconds: baselineSeconds,
    actual_seconds: actualSeconds,
    pct_faster: baselineSeconds > 0 ? Math.round((1 - actualSeconds / baselineSeconds) * 100) : 0,
    recent_24h_count: Number(summary.recent_24h_count) || 0,
    recent_24h_leg_volume_usd: roundUsd(summary.recent_24h_volume_usd),
    recent_24h_volume_usd: roundUsd(summary.recent_24h_volume_usd),
    chain_status: sourceStatus,
    source_status: sourceStatus,
    top_20: topRowsResult.rows.map(normalizeRapidSwapDashboardRow),
    latest_20: latestRowsResult.rows.map(normalizeRapidSwapDashboardRow),
    recent_24h: recentRowsResult.rows.map(normalizeRapidSwapDashboardRow),
    chart_buckets: normalizeDailyBuckets(dailyBucketsResult.rows),
    preaggregates: {
      distributions: {
        sub_swaps: distributionRows.filter((row) => row.dimension === 'sub_swaps'),
        time_saved_seconds: distributionRows.filter((row) => row.dimension === 'time_saved_seconds')
      },
      affiliates: affiliatesResult.rows.map((row) => ({
        affiliate: String(row.affiliate || ''),
        swap_count: Number(row.swap_count) || 0,
        leg_volume_usd: roundUsd(row.volume_usd),
        volume_usd: roundUsd(row.volume_usd)
      })),
      paths,
      sankey: paths.map((row) => ({
        source_asset: row.source_asset,
        target_asset: row.target_asset,
        swap_count: row.swap_count,
        leg_volume_usd: row.leg_volume_usd,
        volume_usd: row.volume_usd
      }))
    },
    backend: {
      last_run_at: toIsoString(lastRunAt),
      last_run_status: lastRunResult.rows[0]?.status || 'unknown',
      freshness_seconds: freshnessSeconds,
      last_run_stats: lastRunStats,
      source_status: sourceStatus,
      live_tail: liveTailStats,
      canonical_source: canonicalSource.provider ? canonicalSource : null,
      pending_candidates: Number(pendingCandidatesResult.rows[0]?.count) || 0,
      canonical_sync: syncStateResult.rows[0]
        ? {
            last_scanned_height: Number(syncStateResult.rows[0].last_scanned_height || 0),
            last_scanned_at: toIsoString(syncStateResult.rows[0].last_scanned_at),
            stats: syncStats
          }
        : null
    },
    ws_listener: wsListenerResult.rows[0]
      ? {
          last_heartbeat: toIsoString(wsListenerResult.rows[0].finished_at),
          status: wsListenerResult.rows[0].status || 'unknown',
          stats: wsListenerResult.rows[0].stats_json || {},
          age_seconds: wsListenerResult.rows[0].finished_at
            ? Math.max(0, Math.floor((now.getTime() - Date.parse(toIsoString(wsListenerResult.rows[0].finished_at))) / 1000))
            : -1
        }
      : null
  };
}
