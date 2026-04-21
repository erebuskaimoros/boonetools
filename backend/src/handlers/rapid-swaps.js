import { query } from '../db/pool.js';
import { json } from '../lib/http.js';
import { toIsoString } from '../lib/utils.js';
import {
  filterRapidSwapsSince,
  rankRapidSwapsByUsd
} from '../../../src/lib/rapid-swaps/model.js';
import {
  getRapidSwapComparableVolumeUsd,
  sumRapidSwapComparableVolumeUsd
} from '../../../src/lib/rapid-swaps/volume.js';

const RAPID_SWAP_COLUMNS = [
  'tx_id',
  'action_height',
  'action_date',
  'observed_at',
  'memo',
  'tx_status',
  'source_asset',
  'target_asset',
  'input_amount_base',
  'output_amount_base',
  'input_estimated_usd',
  'output_estimated_usd',
  'liquidity_fee_base',
  'swap_slip_bps',
  'is_limit_order',
  'streaming_interval',
  'streaming_quantity',
  'streaming_count',
  'blocks_used',
  'affiliate',
  'source_address',
  'destination_address'
].join(', ');

function normalizeRapidSwapRow(row) {
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
    comparable_volume_usd: getRapidSwapComparableVolumeUsd(row),
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

export async function handleRapidSwaps() {
  const recentWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    trackerStartedResult,
    lastRunResult,
    wsListenerResult,
    pendingCandidatesResult,
    syncStateResult
  ] = await Promise.all([
    query('select min(observed_at) as observed_at from rapid_swaps'),
    query(
      `select finished_at, status, stats_json
       from rapid_swap_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['rapid-swaps-recent-actions']
    ),
    query(
      `select finished_at, status, stats_json
       from rapid_swap_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['rapid-swaps-ws-listener']
    ),
    query(
      `select count(*)::bigint as count
       from rapid_swap_candidates
       where status = $1`,
      ['pending']
    ),
    query(
      `select last_scanned_height, last_scanned_at, stats_json
       from rapid_swap_sync_state
       where sync_key = $1
       limit 1`,
      ['rapid-swaps-canonical']
    )
  ]);

  const PAGE_SIZE = 1000;
  const allRows = [];

  for (let page = 0; ; page += 1) {
    const offset = page * PAGE_SIZE;
    const result = await query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       order by action_date desc
       limit $1 offset $2`,
      [PAGE_SIZE, offset]
    );

    if (result.rows.length === 0) {
      break;
    }

    allRows.push(...result.rows.map(normalizeRapidSwapRow));
    if (result.rows.length < PAGE_SIZE) {
      break;
    }
  }

  const trackerStartedAt = trackerStartedResult.rows[0]?.observed_at || null;
  const lastRunAt = lastRunResult.rows[0]?.finished_at || null;
  const recentRows = filterRapidSwapsSince(allRows, Date.parse(recentWindowStart));
  const topRows = rankRapidSwapsByUsd(allRows, 20);
  const cumulativeVolumeUsd = sumRapidSwapComparableVolumeUsd(allRows);
  const recentVolumeUsd = sumRapidSwapComparableVolumeUsd(recentRows);
  const freshnessSeconds = lastRunAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(toIsoString(lastRunAt))) / 1000))
    : -1;

  const blockTimeSeconds = 6;
  let totalSubs = 0;
  let totalBlocksUsed = 0;
  const timeSavedSeconds = allRows.reduce((sum, row) => {
    const subs = Math.max(1, Number(row.streaming_count) || 1);
    const blocksUsed = Math.max(1, Number(row.blocks_used) || 1);
    totalSubs += subs;
    totalBlocksUsed += blocksUsed;
    return sum + Math.max(0, subs - blocksUsed) * blockTimeSeconds;
  }, 0);

  const baselineSeconds = totalSubs * blockTimeSeconds;
  const actualSeconds = totalBlocksUsed * blockTimeSeconds;
  const pctFaster = baselineSeconds > 0
    ? Math.round((1 - actualSeconds / baselineSeconds) * 100)
    : 0;

  return json(
    {
      as_of: new Date().toISOString(),
      tracker_started_at: toIsoString(trackerStartedAt),
      tracker_warmup_complete: trackerStartedAt
        ? (Date.now() - Date.parse(toIsoString(trackerStartedAt))) >= 24 * 60 * 60 * 1000
        : false,
      recent_window_started_at: recentWindowStart,
      total_tracked: allRows.length,
      cumulative_volume_usd: cumulativeVolumeUsd,
      time_saved_seconds: timeSavedSeconds,
      baseline_seconds: baselineSeconds,
      actual_seconds: actualSeconds,
      pct_faster: pctFaster,
      recent_24h_count: recentRows.length,
      recent_24h_volume_usd: recentVolumeUsd,
      top_20: topRows,
      recent_24h: recentRows,
      all_swaps: allRows,
      backend: {
        last_run_at: toIsoString(lastRunAt),
        last_run_status: lastRunResult.rows[0]?.status || 'unknown',
        freshness_seconds: freshnessSeconds,
        last_run_stats: lastRunResult.rows[0]?.stats_json || {},
        pending_candidates: Number(pendingCandidatesResult.rows[0]?.count) || 0,
        canonical_sync: syncStateResult.rows[0]
          ? {
              last_scanned_height: Number(syncStateResult.rows[0].last_scanned_height || 0),
              last_scanned_at: toIsoString(syncStateResult.rows[0].last_scanned_at),
              stats: syncStateResult.rows[0].stats_json || {}
            }
          : null
      },
      ws_listener: wsListenerResult.rows[0]
        ? {
            last_heartbeat: toIsoString(wsListenerResult.rows[0].finished_at),
            status: wsListenerResult.rows[0].status || 'unknown',
            stats: wsListenerResult.rows[0].stats_json || {},
            age_seconds: wsListenerResult.rows[0].finished_at
              ? Math.max(0, Math.floor((Date.now() - Date.parse(toIsoString(wsListenerResult.rows[0].finished_at))) / 1000))
              : -1
          }
        : null
    },
    200,
    {
      'Cache-Control': 'public, max-age=30'
    }
  );
}
