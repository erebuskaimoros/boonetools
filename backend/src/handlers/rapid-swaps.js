import { query } from '../db/pool.js';
import { json, parseIntegerParam } from '../lib/http.js';
import { safeNumber } from '../lib/utils.js';
import { getReadModel } from '../shared/read-models.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import {
  RAPID_SWAP_COLUMNS,
  buildRapidSwapsSummaryPayload,
  normalizeRapidSwapDashboardRow,
  selectRapidSwapChartBuckets
} from '../shared/rapid-swaps-dashboard.js';

export const RAPID_SWAPS_READ_MODEL_KEY = ANALYTICS_READ_MODEL_KEYS.rapidSwaps;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const LEGACY_MAX_ROWS = 1000;
const DEFAULT_CHART_BUCKET_LIMIT = 366;
const MAX_CHART_BUCKET_LIMIT = 1500;

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

function hasParam(url, name) {
  return url?.searchParams?.has(name) || false;
}

function readBooleanParam(url, name, fallback = false) {
  const raw = String(url?.searchParams?.get(name) || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw);
}

export function getRapidSwapsPagination(url) {
  const legacy = readBooleanParam(url, 'legacy', false);
  const includeAll = legacy && readBooleanParam(url, 'include_all', false);
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
    legacy,
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
  if (minUsd > 0) addWhereParam(parts, params, 'comparable_volume_usd >= ?', minUsd);
  if (minSubs > 0) addWhereParam(parts, params, 'coalesce(streaming_count, 0) >= ?', minSubs);

  return {
    whereSql: parts.length ? `where ${parts.join(' and ')}` : '',
    params,
    filtered: parts.length > 0,
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
  const limit = parseIntegerParam(url.searchParams.get('chart_limit'), DEFAULT_CHART_BUCKET_LIMIT, {
    min: 1,
    max: MAX_CHART_BUCKET_LIMIT
  });
  return from > 0 && to > from ? { from, to, limit } : { from: 0, to: 0, limit };
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
  return result.rows.map(normalizeRapidSwapDashboardRow);
}

async function fetchLegacyAllRows() {
  const result = await query(
    `select ${RAPID_SWAP_COLUMNS}
     from rapid_swaps
     order by action_date desc
     limit $1`,
    [LEGACY_MAX_ROWS]
  );
  return result.rows.map(normalizeRapidSwapDashboardRow);
}

function readModelMetadata(model) {
  return {
    key: model.key,
    generated_at: model.generatedAt,
    source_updated_at: model.sourceUpdatedAt,
    age_seconds: model.ageSeconds,
    stale: model.stale
  };
}

export async function handleRapidSwapsSummary(_request, url) {
  const pagination = getRapidSwapsPagination(url);
  const tableWhere = buildTableWhere(url);
  const sort = getSortSql(url);
  const chartRange = getChartRange(url);
  const model = pagination.legacy ? null : await getReadModel(RAPID_SWAPS_READ_MODEL_KEY);

  if (!pagination.legacy && !model) {
    return json({
      error: 'Rapid swaps snapshot is warming',
      retryable: true,
      model_key: RAPID_SWAPS_READ_MODEL_KEY
    }, 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '30'
    });
  }

  const summary = model?.payload || await buildRapidSwapsSummaryPayload();
  const canUseReadModelLatestRows = Boolean(
    model &&
    !pagination.includeAll &&
    !tableWhere.filtered &&
    pagination.offset === 0 &&
    pagination.limit <= 20 &&
    sort.sort === 'date' &&
    sort.order === 'desc' &&
    Array.isArray(summary.latest_20)
  );
  const countPromise = pagination.includeAll
    ? null
    : tableWhere.filtered
      ? query(
          `select count(*)::bigint as count from rapid_swaps ${tableWhere.whereSql}`,
          tableWhere.params
        )
      : null;
  const rowsPromise = pagination.includeAll
    ? fetchLegacyAllRows()
    : canUseReadModelLatestRows
      ? Promise.resolve(summary.latest_20.slice(0, pagination.limit))
    : fetchRowsPage({
        whereSql: tableWhere.whereSql,
        whereParams: tableWhere.params,
        orderSql: sort.sql,
        limit: pagination.limit,
        offset: pagination.offset
      });
  const [countResult, tableRows] = await Promise.all([countPromise, rowsPromise]);
  const tableTotal = pagination.includeAll
    ? tableRows.length
    : tableWhere.filtered
      ? Number(countResult?.rows?.[0]?.count) || 0
      : Number(summary.total_tracked) || 0;

  const selectedChart = selectRapidSwapChartBuckets(summary.chart_buckets, chartRange);
  const chartBuckets = selectedChart.buckets.slice(0, chartRange.limit);
  const chartTruncated = selectedChart.buckets.length > chartBuckets.length;
  const payload = {
    ...summary,
    ...(model ? { read_model: readModelMetadata(model) } : {}),
    ...(model?.stale ? {
      stale: true,
      warning: summary.warning || 'Serving the last successful rapid-swaps snapshot'
    } : {}),
    all_swaps: tableRows,
    chart_swaps: [],
    chart_buckets: chartBuckets,
    pagination: {
      total: tableTotal,
      limit: pagination.includeAll ? tableRows.length : pagination.limit,
      offset: pagination.includeAll ? 0 : pagination.offset,
      page: pagination.includeAll ? 1 : pagination.page,
      total_pages: pagination.includeAll ? 1 : Math.max(1, Math.ceil(tableTotal / pagination.limit)),
      has_next: pagination.includeAll ? false : pagination.offset + pagination.limit < tableTotal,
      has_previous: pagination.includeAll ? false : pagination.offset > 0,
      sort: sort.sort,
      order: sort.order,
      filters: tableWhere.filters,
      truncated: pagination.includeAll && Number(summary.total_tracked || 0) > tableRows.length
    },
    chart: {
      from: chartRange.from,
      to: chartRange.to,
      row_count: selectedChart.rowCount,
      returned_count: chartBuckets.length,
      bucket: 'day',
      truncated: chartTruncated,
      cumulative_count_before: selectedChart.cumulativeCountBefore,
      cumulative_leg_volume_usd_before: selectedChart.cumulativeVolumeBefore,
      cumulative_volume_usd_before: selectedChart.cumulativeVolumeBefore
    }
  };

  return json(payload, 200, {
    'Cache-Control': pagination.legacy ? 'private, no-store' : 'public, max-age=30',
    ...(model ? {
      'X-Boone-Cache': model.stale ? 'read-model-stale' : 'read-model',
      'X-Boone-Age': String(model.ageSeconds ?? 0)
    } : {})
  });
}

async function fetchLegacyChartRows(url) {
  const from = parseIntegerParam(url.searchParams.get('chart_from'), 0, { min: 0 });
  const to = parseIntegerParam(url.searchParams.get('chart_to'), 0, { min: 0 });
  if (!(from > 0 && to > from)) return [];
  const limit = parseIntegerParam(url.searchParams.get('chart_limit'), 5_000, {
    min: 1,
    max: 20_000
  });
  const result = await query(
    `select ${RAPID_SWAP_COLUMNS}
     from rapid_swaps
     where action_date >= $1 and action_date < $2
     order by action_date asc
     limit $3`,
    [new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString(), limit]
  );
  return result.rows.map(normalizeRapidSwapDashboardRow);
}

export async function handleRapidSwaps(request, url) {
  // Preserve the established response for already-open frontend bundles. The
  // new UI uses /rapid-swaps-summary and never pays for these raw chart rows.
  const hasPagination = ['limit', 'offset', 'page', 'page_size', 'include_all']
    .some((name) => url.searchParams.has(name));
  let compatibilityUrl = url;
  if (!hasPagination) {
    compatibilityUrl = new URL(url.toString());
    compatibilityUrl.searchParams.set('legacy', '1');
    compatibilityUrl.searchParams.set('include_all', 'true');
  }
  const [result, chartRows] = await Promise.all([
    handleRapidSwapsSummary(request, compatibilityUrl),
    fetchLegacyChartRows(url)
  ]);
  if (Number(result?.status || 200) >= 400 || !result?.body) return result;
  return json({
    ...result.body,
    chart_swaps: chartRows,
    chart: {
      ...(result.body.chart || {}),
      returned_count: chartRows.length,
      truncated: Number(result.body.chart?.row_count || 0) > chartRows.length
    }
  }, result.status, result.headers);
}
