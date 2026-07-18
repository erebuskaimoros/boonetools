import { query } from '../db/pool.js';
import { json, parseIntegerParam } from '../lib/http.js';
import { safeNumber, toIsoString } from '../lib/utils.js';
import { getRapidSwapComparableVolumeUsd } from '../../../shared/rapid-swaps/volume.js';

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
  'comparable_volume_usd',
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

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const LEGACY_PAGE_SIZE = 1000;
const DEFAULT_CHART_LIMIT = 5000;
const MAX_CHART_LIMIT = 20000;

const SORT_COLUMNS = Object.freeze({
  date: (direction) => `action_date ${direction}`,
  pair: (direction) => `source_asset ${direction}, target_asset ${direction}, action_date desc`,
  usd: (direction) => `comparable_volume_usd ${direction}`,
  subs: (direction) => `streaming_count ${direction}`,
  blocks: (direction) => `blocks_used ${direction}`,
  timeSaved: (direction) => `greatest(coalesce(streaming_count, 0) - coalesce(blocks_used, 0), 0) ${direction}`,
  pctFaster: (direction) => (
    `case when coalesce(streaming_count, 0) > 0 and coalesce(blocks_used, 0) > 0 ` +
    `then 1 - (coalesce(blocks_used, 0)::double precision / coalesce(streaming_count, 0)::double precision) ` +
    `else 0 end ${direction}`
  )
});

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

function roundUsd(value) {
  const numeric = safeNumber(value, 0);
  return Math.round(numeric * 100) / 100;
}

function hasParam(url, name) {
  return url?.searchParams?.has(name) || false;
}

function readBooleanParam(url, name, fallback = false) {
  const raw = String(url?.searchParams?.get(name) || '').trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'y'].includes(raw);
}

function getPagination(url) {
  const requested = ['limit', 'offset', 'page', 'page_size', 'include_all'].some((name) => hasParam(url, name));
  const includeAll = readBooleanParam(url, 'include_all', !requested);
  const pageSize = parseIntegerParam(
    url.searchParams.get('page_size') || url.searchParams.get('limit'),
    DEFAULT_PAGE_SIZE,
    { min: 1, max: MAX_PAGE_SIZE }
  );
  const page = parseIntegerParam(url.searchParams.get('page'), 1, { min: 1 });
  const offset = hasParam(url, 'offset')
    ? parseIntegerParam(url.searchParams.get('offset'), 0, { min: 0 })
    : (page - 1) * pageSize;

  return {
    requested,
    includeAll,
    limit: pageSize,
    offset,
    page: Math.floor(offset / pageSize) + 1
  };
}

function addWhereParam(parts, params, sql, value) {
  params.push(value);
  parts.push(sql.replace('?', `$${params.length}`));
}

function buildTableWhere(url) {
  const parts = [];
  const params = [];
  const path = String(url.searchParams.get('path') || url.searchParams.get('filter_path') || '').trim();
  const minUsd = safeNumber(url.searchParams.get('min_usd'), 0);
  const minSubs = safeNumber(url.searchParams.get('min_subs'), 0);

  if (path) {
    const value = `%${path}%`;
    params.push(value, value, value);
    parts.push(
      `(source_asset ilike $${params.length - 2} or target_asset ilike $${params.length - 1} or concat(source_asset, ' -> ', target_asset) ilike $${params.length})`
    );
  }

  if (minUsd > 0) {
    addWhereParam(parts, params, 'comparable_volume_usd >= ?', minUsd);
  }

  if (minSubs > 0) {
    addWhereParam(parts, params, 'coalesce(streaming_count, 0) >= ?', minSubs);
  }

  return {
    whereSql: parts.length ? `where ${parts.join(' and ')}` : '',
    params,
    filters: {
      path,
      min_usd: minUsd > 0 ? minUsd : 0,
      min_subs: minSubs > 0 ? minSubs : 0
    }
  };
}

function getSortSql(url) {
  const sort = String(url.searchParams.get('sort') || 'date');
  const normalizedSort = SORT_COLUMNS[sort] ? sort : 'date';
  const order = String(url.searchParams.get('order') || url.searchParams.get('direction') || 'desc').toLowerCase();
  const direction = order === 'asc' ? 'asc' : 'desc';
  const expression = SORT_COLUMNS[normalizedSort](direction);
  const needsDateTieBreaker = normalizedSort !== 'date' && normalizedSort !== 'pair';
  return {
    sort: normalizedSort,
    order: direction,
    sql: `${expression}${needsDateTieBreaker ? ', action_date desc' : ''}, tx_id asc`
  };
}

function getChartRange(url) {
  const from = parseIntegerParam(url.searchParams.get('chart_from'), 0, { min: 0 });
  const to = parseIntegerParam(url.searchParams.get('chart_to'), 0, { min: 0 });
  const limit = parseIntegerParam(url.searchParams.get('chart_limit'), DEFAULT_CHART_LIMIT, {
    min: 1,
    max: MAX_CHART_LIMIT
  });

  if (from > 0 && to > 0 && from < to) {
    return {
      from,
      to,
      fromIso: new Date(from * 1000).toISOString(),
      toIso: new Date(to * 1000).toISOString(),
      limit
    };
  }

  return {
    from: 0,
    to: 0,
    fromIso: '',
    toIso: '',
    limit
  };
}

async function fetchRowsPage({ whereSql, whereParams, orderSql, limit, offset }) {
  const result = await query(
    `select ${RAPID_SWAP_COLUMNS}
     from rapid_swaps
     ${whereSql}
     order by ${orderSql}
     limit $${whereParams.length + 1} offset $${whereParams.length + 2}`,
    [...whereParams, limit, offset]
  );

  return result.rows.map(normalizeRapidSwapRow);
}

async function fetchLegacyAllRows() {
  const allRows = [];

  for (let page = 0; ; page += 1) {
    const offset = page * LEGACY_PAGE_SIZE;
    const result = await query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       order by action_date desc
       limit $1 offset $2`,
      [LEGACY_PAGE_SIZE, offset]
    );

    if (result.rows.length === 0) {
      break;
    }

    allRows.push(...result.rows.map(normalizeRapidSwapRow));
    if (result.rows.length < LEGACY_PAGE_SIZE) {
      break;
    }
  }

  return allRows;
}

async function fetchChartRows(chartRange) {
  if (!chartRange.fromIso || !chartRange.toIso) {
    return {
      rows: [],
      total: 0,
      cumulativeCountBefore: 0,
      cumulativeVolumeBefore: 0,
      truncated: false
    };
  }

  const [rowsResult, totalResult, seedResult] = await Promise.all([
    query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       where action_date >= $1 and action_date < $2
       order by action_date asc
       limit $3`,
      [chartRange.fromIso, chartRange.toIso, chartRange.limit]
    ),
    query(
      `select count(*)::bigint as count
       from rapid_swaps
       where action_date >= $1 and action_date < $2`,
      [chartRange.fromIso, chartRange.toIso]
    ),
    query(
      `select count(*)::bigint as count,
              coalesce(sum(comparable_volume_usd), 0) as volume
       from rapid_swaps
       where action_date < $1`,
      [chartRange.fromIso]
    )
  ]);

  const total = Number(totalResult.rows[0]?.count) || 0;
  return {
    rows: rowsResult.rows.map(normalizeRapidSwapRow),
    total,
    cumulativeCountBefore: Number(seedResult.rows[0]?.count) || 0,
    cumulativeVolumeBefore: roundUsd(seedResult.rows[0]?.volume),
    truncated: total > rowsResult.rows.length
  };
}

export async function handleRapidSwaps(_request, url) {
  const recentWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pagination = getPagination(url);
  const tableWhere = buildTableWhere(url);
  const sort = getSortSql(url);
  const chartRange = getChartRange(url);

  const [
    summaryResult,
    tableCountResult,
    tableRows,
    chartRowsResult,
    topRowsResult,
    recentRowsResult,
    lastRunResult,
    wsListenerResult,
    pendingCandidatesResult,
    syncStateResult
  ] = await Promise.all([
    query(
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
    query(
      `select count(*)::bigint as count
       from rapid_swaps
       ${tableWhere.whereSql}`,
      tableWhere.params
    ),
    pagination.includeAll
      ? fetchLegacyAllRows()
      : fetchRowsPage({
          whereSql: tableWhere.whereSql,
          whereParams: tableWhere.params,
          orderSql: sort.sql,
          limit: pagination.limit,
          offset: pagination.offset
        }),
    fetchChartRows(chartRange),
    query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       order by comparable_volume_usd desc, action_date desc
       limit 20`
    ),
    query(
      `select ${RAPID_SWAP_COLUMNS}
       from rapid_swaps
       where action_date >= $1
       order by action_date desc`,
      [recentWindowStart]
    ),
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
  const totalTracked = Number(summary.total_tracked) || 0;
  const tableTotal = Number(tableCountResult.rows[0]?.count) || 0;
  const topRows = topRowsResult.rows.map(normalizeRapidSwapRow);
  const recentRows = recentRowsResult.rows.map(normalizeRapidSwapRow);
  const cumulativeVolumeUsd = roundUsd(summary.cumulative_volume_usd);
  const recentVolumeUsd = roundUsd(summary.recent_24h_volume_usd);
  const freshnessSeconds = lastRunAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(toIsoString(lastRunAt))) / 1000))
    : -1;

  const blockTimeSeconds = 6;
  const totalSubs = Number(summary.total_subs) || 0;
  const totalBlocksUsed = Number(summary.total_blocks_used) || 0;
  const timeSavedSeconds = (Number(summary.saved_blocks) || 0) * blockTimeSeconds;
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
      total_tracked: totalTracked,
      cumulative_volume_usd: cumulativeVolumeUsd,
      time_saved_seconds: timeSavedSeconds,
      baseline_seconds: baselineSeconds,
      actual_seconds: actualSeconds,
      pct_faster: pctFaster,
      recent_24h_count: Number(summary.recent_24h_count) || recentRows.length,
      recent_24h_volume_usd: recentVolumeUsd,
      chain_status: sourceStatus,
      source_status: sourceStatus,
      top_20: topRows,
      recent_24h: recentRows,
      all_swaps: tableRows,
      chart_swaps: chartRowsResult.rows,
      pagination: {
        total: pagination.includeAll ? tableRows.length : tableTotal,
        limit: pagination.includeAll ? tableRows.length : pagination.limit,
        offset: pagination.includeAll ? 0 : pagination.offset,
        page: pagination.includeAll ? 1 : pagination.page,
        total_pages: pagination.includeAll
          ? 1
          : Math.max(1, Math.ceil(tableTotal / pagination.limit)),
        has_next: pagination.includeAll ? false : pagination.offset + pagination.limit < tableTotal,
        has_previous: pagination.includeAll ? false : pagination.offset > 0,
        sort: sort.sort,
        order: sort.order,
        filters: tableWhere.filters
      },
      chart: {
        from: chartRange.from,
        to: chartRange.to,
        row_count: chartRowsResult.total,
        returned_count: chartRowsResult.rows.length,
        truncated: chartRowsResult.truncated,
        cumulative_count_before: chartRowsResult.cumulativeCountBefore,
        cumulative_volume_usd_before: chartRowsResult.cumulativeVolumeBefore
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
