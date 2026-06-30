import { config } from '../lib/config.js';
import { executeDuneQueryRows, formatDuneDateTime } from './dune.js';

export {
  ACTION_PAGE_LIMIT,
  DIRECT_RESOLUTION_HEIGHT_BUFFER,
  RECENT_SCAN_HEIGHT_BUFFER,
  fetchRapidSwapPriceIndex,
  fetchRapidSwapRows,
  fetchRapidSwapSourceStatus,
  fetchThorchainTx,
  getRapidSwapRateLimitCooldownMs,
  isRapidSwapRateLimitError,
  resolveRapidSwapHint,
  enrichRapidSwapHint
} from '../../../src/lib/rapid-swaps/backend.js';

export {
  buildRapidSwapCanonicalScanPlan,
  mergeRapidSwapRowsByTxId,
  shouldSkipRapidSwapCanonicalScanForHealthyListener,
  summarizeRapidSwapCanonicalScan
} from '../../../src/lib/rapid-swaps/ingestion.js';

export {
  normalizeRapidSwapHint,
  RAPID_SWAP_CANDIDATE_STATUS
} from '../../../src/lib/rapid-swaps/reconciliation.js';

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeString(value) {
  return String(value ?? '').trim();
}

function normalizeDuneRapidSwapRow(row) {
  const txId = safeString(row?.tx_id).toUpperCase();
  const actionDate = toIsoOrNull(row?.action_date);
  if (!txId || !actionDate) {
    return null;
  }

  return {
    tx_id: txId,
    action_height: Math.max(0, Math.trunc(safeNumber(row?.action_height, 0))),
    action_date: actionDate,
    observed_at: toIsoOrNull(row?.observed_at) || new Date().toISOString(),
    memo: safeString(row?.memo),
    status: 'completed',
    tx_status: safeString(row?.tx_status) || 'success',
    source_asset: safeString(row?.source_asset),
    target_asset: safeString(row?.target_asset),
    input_amount_base: safeString(row?.input_amount_base) || '0',
    output_amount_base: safeString(row?.output_amount_base) || '0',
    input_estimated_usd: safeNumber(row?.input_estimated_usd, 0),
    output_estimated_usd: safeNumber(row?.output_estimated_usd, 0),
    comparable_volume_usd: safeNumber(row?.comparable_volume_usd, 0),
    liquidity_fee_base: safeString(row?.liquidity_fee_base) || '0',
    swap_slip_bps: Math.trunc(safeNumber(row?.swap_slip_bps, 0)),
    is_limit_order: Boolean(row?.is_limit_order),
    streaming_interval: Math.trunc(safeNumber(row?.streaming_interval, 0)),
    streaming_quantity: Math.trunc(safeNumber(row?.streaming_quantity, 0)),
    streaming_count: Math.trunc(safeNumber(row?.streaming_count, 0)),
    blocks_used: Math.trunc(safeNumber(row?.blocks_used, 0)),
    affiliate: safeString(row?.affiliate),
    source_address: safeString(row?.source_address),
    destination_address: safeString(row?.destination_address),
    raw_action: {
      source: 'dune',
      dune_query_id: config.rapidSwapsDuneQueryId,
      row
    }
  };
}

export function buildRapidSwapRowsFromDune(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeDuneRapidSwapRow)
    .filter((row) => (
      row &&
      row.streaming_interval === 0 &&
      row.streaming_quantity > 1 &&
      row.streaming_count === row.streaming_quantity &&
      row.comparable_volume_usd > 0
    ));
}

export async function fetchRapidSwapRowsFromDune(options = {}) {
  const startTime = options.startTime || config.rapidSwapsDuneStartTime;
  const endTime = options.endTime || new Date().toISOString();
  const limit = Math.max(1, Math.trunc(Number(options.limit || config.rapidSwapsDuneLimit) || 5000));
  const result = await executeDuneQueryRows(config.rapidSwapsDuneQueryId, {
    start_time: formatDuneDateTime(startTime),
    end_time: formatDuneDateTime(endTime),
    limit
  }, {
    limit
  });
  const rows = buildRapidSwapRowsFromDune(result.rows);
  const heights = rows.map((row) => Number(row.action_height || 0)).filter((height) => height > 0);

  return {
    executionId: result.executionId,
    rows,
    scannedActions: result.rows.length,
    observedAt: new Date().toISOString(),
    highestHeight: heights.length ? Math.max(...heights) : 0,
    lowestHeight: heights.length ? Math.min(...heights) : 0
  };
}

function normalizeMarketHistoryInterval(row) {
  const startTime = Math.max(0, Math.trunc(safeNumber(row?.startTime, 0)));
  const endTime = Math.max(0, Math.trunc(safeNumber(row?.endTime, 0)));
  if (startTime <= 0 || endTime <= startTime) {
    return null;
  }

  return {
    startTime: String(startTime),
    endTime: String(endTime),
    totalVolumeUSD: String(Math.max(0, Math.trunc(safeNumber(row?.totalVolumeUSD, 0)))),
    totalCount: String(Math.max(0, Math.trunc(safeNumber(row?.totalCount, 0))))
  };
}

export async function fetchRapidSwapMarketHistoryFromDune(params = {}) {
  const interval = ['hour', 'day', 'week', 'month'].includes(params.interval)
    ? params.interval
    : 'hour';
  const startTime = toIsoOrNull(params.startTime) || new Date((Number(params.from) || 0) * 1000).toISOString();
  const endTime = toIsoOrNull(params.endTime) || new Date((Number(params.to) || 0) * 1000).toISOString();
  const result = await executeDuneQueryRows(config.rapidSwapsMarketHistoryDuneQueryId, {
    interval,
    start_time: formatDuneDateTime(startTime),
    end_time: formatDuneDateTime(endTime)
  });

  return {
    meta: {
      source: 'dune',
      query_id: config.rapidSwapsMarketHistoryDuneQueryId,
      execution_id: result.executionId
    },
    intervals: (Array.isArray(result.rows) ? result.rows : [])
      .map(normalizeMarketHistoryInterval)
      .filter(Boolean)
  };
}
