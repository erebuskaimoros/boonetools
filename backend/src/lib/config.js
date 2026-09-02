import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = path.resolve(__dirname, '../../.env');

dotenv.config({
  path: process.env.BOONETOOLS_ENV_FILE || defaultEnvPath
});

function readInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function optional(value) {
  return String(value || '').trim();
}

function readBool(name, fallback) {
  const value = optional(process.env[name]).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function readList(name, fallback = []) {
  const raw = optional(process.env[name]);
  const values = raw
    ? raw.split(',').map((value) => value.trim()).filter(Boolean)
    : fallback.map((value) => optional(value)).filter(Boolean);

  return [...new Set(values)];
}

const thornodePrimaryUrl = optional(process.env.THORNODE_PRIMARY_URL) || 'https://gateway.liquify.com/chain/thorchain_api';
const thornodeArchiveUrl = optional(process.env.THORNODE_ARCHIVE_URL) || thornodePrimaryUrl;
const thornodeFallbackUrl = '';
const midgardUrl = optional(process.env.MIDGARD_URL) || 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
const midgardFallbackUrl = '';
const rpcWsUrl = optional(process.env.RPC_WS_URL) || 'wss://gateway.liquify.com/chain/thorchain_rpc/websocket';
const rpcRestUrl = optional(process.env.RPC_REST_URL) || 'https://gateway.liquify.com/chain/thorchain_rpc';
const rpcFallbackRestUrl = '';
const rpcArchiveRestUrl = optional(process.env.RPC_ARCHIVE_REST_URL) || 'https://rpc.thorchain.liquify.com';
const bifrostScannerInfoUrl = optional(process.env.BIFROST_SCANNER_INFO_URL)
  || 'https://vanaheimex.com/api/nodesInfo';
const duneApiBaseUrl = optional(process.env.DUNE_API_BASE_URL) || 'https://api.dune.com';
const binanceApiBaseUrl = optional(process.env.BINANCE_API_BASE_URL) || 'https://data-api.binance.vision';
const cmcApiKey = optional(process.env.CMC_API_KEY || process.env.CMC_PRO_API_KEY);
const providerCooldownEnabled = readBool(
  'PROVIDER_COOLDOWN_ENABLED',
  optional(process.env.NODE_ENV).toLowerCase() === 'production'
);

export const config = Object.freeze({
  port: readInt('PORT', 8787),
  databaseUrl: optional(process.env.DATABASE_URL),
  publicApiKey: optional(
    process.env.PUBLIC_API_KEY
      || process.env.VITE_NODEOP_API_KEY
      || process.env.VITE_RAPID_SWAPS_API_KEY
  ),
  providerClientId: optional(process.env.BOONETOOLS_PROVIDER_CLIENT_ID) || 'BooneTools',
  providerCooldownEnabled,
  providerFailureCooldownMs: readInt('PROVIDER_FAILURE_COOLDOWN_SECONDS', 60) * 1000,
  providerRateLimitCooldownMs: readInt('PROVIDER_RATE_LIMIT_COOLDOWN_SECONDS', 60 * 60) * 1000,
  thornodePrimaryUrl,
  thornodeArchiveUrl,
  thornodeFallbackUrl,
  thornodeUrls: readList('THORNODE_URLS', [
    thornodePrimaryUrl,
    thornodeFallbackUrl
  ]),
  midgardUrl,
  midgardFallbackUrl,
  midgardUrls: readList('MIDGARD_URLS', [
    midgardUrl,
    midgardFallbackUrl
  ]),
  rpcRestUrl,
  rpcArchiveRestUrl,
  rpcRestUrls: readList('RPC_REST_URLS', [
    rpcRestUrl,
    rpcFallbackRestUrl
  ]),
  rpcWsUrl,
  rpcWsUrls: readList('RPC_WS_URLS', [rpcWsUrl]),
  bifrostScannerInfoUrl,
  bifrostScannerInfoTimeoutMs: readInt('BIFROST_SCANNER_INFO_TIMEOUT_MS', 8_000),
  midgardDelayMs: readInt('MIDGARD_DELAY_MS', 5000),
  rapidSwapsMaxPages: readInt('RAPID_SWAPS_MAX_PAGES', 200),
  rapidSwapsCatchupMaxPages: readInt('RAPID_SWAPS_CATCHUP_MAX_PAGES', 200),
  rapidSwapsCanonicalScanIntervalMs: readInt('RAPID_SWAPS_CANONICAL_SCAN_INTERVAL_SECONDS', 15 * 60) * 1000,
  rapidSwapsNormalHeadPages: readInt('RAPID_SWAPS_NORMAL_HEAD_PAGES', 4),
  rapidSwapsLaggingHeadPages: readInt('RAPID_SWAPS_LAGGING_HEAD_PAGES', 2),
  rapidSwapsCatchupPages: readInt('RAPID_SWAPS_CATCHUP_PAGES', 2),
  rapidSwapsRateLimitCooldownMs: readInt('RAPID_SWAPS_RATE_LIMIT_COOLDOWN_SECONDS', 60 * 60) * 1000,
  rapidSwapsSourceIdleCooldownMs: readInt('RAPID_SWAPS_SOURCE_IDLE_COOLDOWN_SECONDS', 15 * 60) * 1000,
  rapidSwapsHeightOverlapBlocks: readInt('RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS', 1800),
  rapidSwapsMaxCandidateAttempts: readInt('RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS', 12),
  rapidSwapsPendingCandidateBatch: readInt('RAPID_SWAPS_PENDING_CANDIDATE_BATCH', 100),
  rapidSwapsListenerBlockStallMs: readInt('RAPID_SWAPS_LISTENER_BLOCK_STALL_SECONDS', 3 * 60) * 1000,
  rapidSwapsWsIngestionEnabled: readBool('RAPID_SWAPS_WS_INGESTION_ENABLED', false),
  rapidSwapsDuneQueryId: optional(process.env.RAPID_SWAPS_DUNE_QUERY_ID) || '7619996',
  rapidSwapsDuneStartTime: optional(process.env.RAPID_SWAPS_DUNE_START_TIME) || '2026-04-01T00:00:00Z',
  rapidSwapsDuneDaysPerRun: readInt('RAPID_SWAPS_DUNE_DAYS_PER_RUN', 3),
  rapidSwapsDuneHeadLagHours: readInt('RAPID_SWAPS_DUNE_HEAD_LAG_HOURS', 6),
  rapidSwapsDuneLimit: readInt('RAPID_SWAPS_DUNE_LIMIT', 5000),
  rapidSwapsDuneScanIntervalMs: readInt('RAPID_SWAPS_DUNE_SCAN_INTERVAL_SECONDS', 6 * 60 * 60) * 1000,
  rapidSwapsLiveTailIntervalMs: readInt('RAPID_SWAPS_LIVE_TAIL_INTERVAL_SECONDS', 5 * 60) * 1000,
  rapidSwapsLiveTailPages: readInt('RAPID_SWAPS_LIVE_TAIL_PAGES', 2),
  rapidSwapsMarketHistoryDuneQueryId: optional(process.env.RAPID_SWAPS_MARKET_HISTORY_DUNE_QUERY_ID) || '7620035',
  appLayerLiveStateTtlMs: readInt('APP_LAYER_LIVE_STATE_TTL_SECONDS', 2 * 60) * 1000,
  appLayerStaticStateTtlMs: readInt('APP_LAYER_STATIC_STATE_TTL_SECONDS', 15 * 60) * 1000,
  appLayerRouteConcurrency: readInt('APP_LAYER_ROUTE_CONCURRENCY', 4),
  rujiraBaseFeesMidgardUrls: readList('RUJIRA_BASE_FEES_MIDGARD_URLS', [
    midgardUrl,
    midgardFallbackUrl
  ]),
  rujiraBaseFeesRpcUrls: readList('RUJIRA_BASE_FEES_RPC_URLS', [
    rpcRestUrl,
    rpcFallbackRestUrl
  ]),
  rujiraBaseFeesMidgardHeadMaxPages: readInt('RUJIRA_BASE_FEES_MIDGARD_HEAD_MAX_PAGES', 10),
  rujiraBaseFeesMidgardHeadLookbackBlocks: readInt(
    'RUJIRA_BASE_FEES_MIDGARD_HEAD_LOOKBACK_BLOCKS',
    50_000
  ),
  rujiraBaseFeesMidgardMaxPages: readInt('RUJIRA_BASE_FEES_MIDGARD_MAX_PAGES', 10),
  rujiraBaseFeesBlockMaxHeights: readInt('RUJIRA_BASE_FEES_BLOCK_MAX_HEIGHTS', 75),
  rujiraBaseFeesRpcBatchSize: readInt('RUJIRA_BASE_FEES_RPC_BATCH_SIZE', 10),
  rujiraBaseFeesRequestDelayMs: readInt('RUJIRA_BASE_FEES_REQUEST_DELAY_MS', 250),
  rujiraBaseFeesRateLimitCooldownMs: readInt('RUJIRA_BASE_FEES_RATE_LIMIT_COOLDOWN_SECONDS', 60 * 60) * 1000,
  rujiraBaseFeesDuneQueryId: optional(process.env.RUJIRA_BASE_FEES_DUNE_QUERY_ID) || '7620091',
  rujiraBaseFeesDuneStartTime: optional(process.env.RUJIRA_BASE_FEES_DUNE_START_TIME) || '2026-04-30T00:00:00Z',
  rujiraBaseFeesDuneDaysPerRun: readInt('RUJIRA_BASE_FEES_DUNE_DAYS_PER_RUN', 3),
  rujiraBaseFeesDuneHeadLagHours: readInt('RUJIRA_BASE_FEES_DUNE_HEAD_LAG_HOURS', 6),
  rujiraBaseFeesDuneLimit: readInt('RUJIRA_BASE_FEES_DUNE_LIMIT', 5000),
  rujiraReservePaymentsMidgardUrls: readList('RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS', [
    midgardUrl,
    midgardFallbackUrl
  ]),
  rujiraReservePaymentsRpcUrls: readList('RUJIRA_RESERVE_PAYMENTS_RPC_URLS', [
    rpcRestUrl,
    rpcFallbackRestUrl
  ]),
  rujiraReservePaymentsStartHeight: readInt('RUJIRA_RESERVE_PAYMENTS_START_HEIGHT', 25982820),
  rujiraReservePaymentsScheduleBlocks: readInt('RUJIRA_RESERVE_PAYMENTS_SCHEDULE_BLOCKS', 101),
  rujiraReservePaymentsHeadLagBlocks: readInt('RUJIRA_RESERVE_PAYMENTS_HEAD_LAG_BLOCKS', 2),
  rujiraReservePaymentsMidgardMaxPages: readInt('RUJIRA_RESERVE_PAYMENTS_MIDGARD_MAX_PAGES', 4),
  rujiraReservePaymentsCandidateMaxHeights: readInt('RUJIRA_RESERVE_PAYMENTS_CANDIDATE_MAX_HEIGHTS', 300),
  rujiraReservePaymentsBlockMaxHeights: readInt('RUJIRA_RESERVE_PAYMENTS_BLOCK_MAX_HEIGHTS', 150),
  rujiraReservePaymentsRequestDelayMs: readInt('RUJIRA_RESERVE_PAYMENTS_REQUEST_DELAY_MS', 100),
  rujiraReservePaymentsRateLimitCooldownMs: readInt('RUJIRA_RESERVE_PAYMENTS_RATE_LIMIT_COOLDOWN_SECONDS', 60 * 60) * 1000,
  rujiraReservePaymentsDuneQueryId: optional(process.env.RUJIRA_RESERVE_PAYMENTS_DUNE_QUERY_ID) || '7620011',
  rujiraReservePaymentsDuneStartTime: optional(process.env.RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME) || '2026-04-30T00:00:00Z',
  rujiraReservePaymentsDuneHeadLagHours: readInt('RUJIRA_RESERVE_PAYMENTS_DUNE_HEAD_LAG_HOURS', 6),
  bondTxEventsDuneQueryId: optional(process.env.BOND_TX_EVENTS_DUNE_QUERY_ID) || '7620042',
  bondTxEventsDuneStartTime: optional(process.env.BOND_TX_EVENTS_DUNE_START_TIME) || '2022-01-01T00:00:00Z',
  bondTxEventsDuneLimit: readInt('BOND_TX_EVENTS_DUNE_LIMIT', 1000),
  nodeVotesRpcUrls: readList('NODE_VOTES_RPC_URLS', [
    rpcArchiveRestUrl,
    rpcRestUrl,
    rpcFallbackRestUrl
  ]),
  nodeVotesBackfillMonths: readInt('NODE_VOTES_BACKFILL_MONTHS', 6),
  nodeVotesBackfillLookbackDays: readInt('NODE_VOTES_BACKFILL_LOOKBACK_DAYS', 14),
  nodeVotesTxSearchPageSize: readInt('NODE_VOTES_TX_SEARCH_PAGE_SIZE', 100),
  nodeVotesRequestDelayMs: readInt('NODE_VOTES_REQUEST_DELAY_MS', 150),
  nodeVotesBlockTimeConcurrency: readInt('NODE_VOTES_BLOCK_TIME_CONCURRENCY', 4),
  nodeVotesNodeMetadataConcurrency: readInt('NODE_VOTES_NODE_METADATA_CONCURRENCY', 4),
  nodeVotesDuneQueryId: optional(process.env.NODE_VOTES_DUNE_QUERY_ID) || '7619989',
  nodeVotesWsIngestionEnabled: readBool('NODE_VOTES_WS_INGESTION_ENABLED', true),
  duneApiKey: optional(process.env.DUNE_API_KEY),
  duneApiBaseUrl,
  binanceApiBaseUrl,
  binanceApiBaseUrls: readList('BINANCE_API_BASE_URLS', [binanceApiBaseUrl]),
  poolDislocationBackfillRequestDelayMs: readInt('POOL_DISLOCATION_BACKFILL_REQUEST_DELAY_MS', 100),
  poolDislocationBackfillBatchBuckets: readInt('POOL_DISLOCATION_BACKFILL_BATCH_BUCKETS', 12),
  poolDislocationBackfillRetryAttempts: readInt('POOL_DISLOCATION_BACKFILL_RETRY_ATTEMPTS', 8),
  poolDislocationBackfillRetryBaseDelayMs: readInt('POOL_DISLOCATION_BACKFILL_RETRY_BASE_DELAY_MS', 1000),
  poolDislocationBackfillRetryMaxDelayMs: readInt('POOL_DISLOCATION_BACKFILL_RETRY_MAX_DELAY_MS', 60_000),
  poolDislocationThornodeUrls: readList('POOL_DISLOCATION_THORNODE_URLS', [thornodePrimaryUrl]),
  poolDislocationSnapshotRetryAttempts: readInt('POOL_DISLOCATION_SNAPSHOT_RETRY_ATTEMPTS', 3),
  poolDislocationSnapshotRetryBaseDelayMs: readInt('POOL_DISLOCATION_SNAPSHOT_RETRY_BASE_DELAY_MS', 1000),
  poolDislocationCoreFallbackMaxAgeMs: readInt('POOL_DISLOCATION_CORE_FALLBACK_MAX_AGE_SECONDS', 180) * 1000,
  poolDislocationTradingFallbackMaxAgeMs: readInt(
    'POOL_DISLOCATION_TRADING_FALLBACK_MAX_AGE_SECONDS',
    15 * 60
  ) * 1000,
  poolDislocationRepairLookbackHours: readInt('POOL_DISLOCATION_REPAIR_LOOKBACK_HOURS', 7 * 24),
  poolDislocationRepairMaxBuckets: readInt('POOL_DISLOCATION_REPAIR_MAX_BUCKETS', 24),
  poolDislocationRepairRetryAttempts: readInt('POOL_DISLOCATION_REPAIR_RETRY_ATTEMPTS', 4),
  poolDislocationRepairRetryBaseDelayMs: readInt('POOL_DISLOCATION_REPAIR_RETRY_BASE_DELAY_MS', 500),
  poolDislocationRepairRetryMaxDelayMs: readInt('POOL_DISLOCATION_REPAIR_RETRY_MAX_DELAY_MS', 10_000),
  poolAnalysisStartDate: optional(process.env.POOL_ANALYSIS_START_DATE) || '2021-04-01',
  poolAnalysisRecentLookbackDays: readInt('POOL_ANALYSIS_RECENT_LOOKBACK_DAYS', 35),
  poolAnalysisRequestDelayMs: readInt('POOL_ANALYSIS_REQUEST_DELAY_MS', 100),
  poolAnalysisMaxPages: readInt('POOL_ANALYSIS_MAX_PAGES', 30),
  poolAnalysisConcurrency: readInt('POOL_ANALYSIS_CONCURRENCY', 2),
  poolAnalysisHistoryRequestLimit: readInt('POOL_ANALYSIS_HISTORY_REQUEST_LIMIT', 20),
  poolAnalysisCoreMaxAgeMs: readInt('POOL_ANALYSIS_CORE_MAX_AGE_MS', 300000),
  polTrackerStartDate: optional(process.env.POL_TRACKER_START_DATE) || '2025-02-01',
  polTrackerThornodeUrls: readList('POL_TRACKER_THORNODE_URLS', [
    thornodeArchiveUrl,
    thornodePrimaryUrl
  ]),
  polTrackerRpcUrls: readList('POL_TRACKER_RPC_URLS', [
    rpcArchiveRestUrl,
    rpcRestUrl
  ]),
  polTrackerLpConcurrency: readInt('POL_TRACKER_LP_CONCURRENCY', 4),
  polTrackerRequestDelayMs: readInt('POL_TRACKER_REQUEST_DELAY_MS', 75),
  polTrackerTimeoutMs: readInt('POL_TRACKER_TIMEOUT_MS', 12_000),
  polTrackerAnchorBatchDays: readInt('POL_TRACKER_ANCHOR_BATCH_DAYS', 31),
  polTrackerRecentLookbackDays: readInt('POL_TRACKER_RECENT_LOOKBACK_DAYS', 7),
  polTrackerHeadLagDays: readInt('POL_TRACKER_HEAD_LAG_DAYS', 0),
  polTrackerRetryAttempts: readInt('POL_TRACKER_RETRY_ATTEMPTS', 4),
  polTrackerRetryBaseDelayMs: readInt('POL_TRACKER_RETRY_BASE_DELAY_MS', 1000),
  polTrackerRetryMaxDelayMs: readInt('POL_TRACKER_RETRY_MAX_DELAY_MS', 30_000),
  burnTrackerStartDate: optional(process.env.BURN_TRACKER_START_DATE) || '2024-09-26',
  burnTrackerRecentLookbackDays: readInt('BURN_TRACKER_RECENT_LOOKBACK_DAYS', 7),
  burnTrackerRequestDelayMs: readInt('BURN_TRACKER_REQUEST_DELAY_MS', 250),
  systemIncomePolActivationHeight: readInt('SYSTEM_INCOME_POL_ACTIVATION_HEIGHT', 27636623),
  systemIncomePolRepairBlocksPerRun: readInt('SYSTEM_INCOME_POL_REPAIR_BLOCKS_PER_RUN', 30_000),
  systemIncomePolRepairMaxBatches: readInt('SYSTEM_INCOME_POL_REPAIR_MAX_BATCHES', 24),
  systemIncomePolRepairConcurrency: readInt('SYSTEM_INCOME_POL_REPAIR_CONCURRENCY', 6),
  systemIncomePolLpConcurrency: readInt('SYSTEM_INCOME_POL_LP_CONCURRENCY', 4),
  systemIncomePolTimeoutMs: readInt('SYSTEM_INCOME_POL_TIMEOUT_MS', 12_000),
  dunePerformance: optional(process.env.DUNE_PERFORMANCE) || 'small',
  duneExecutionPollMs: readInt('DUNE_EXECUTION_POLL_MS', 5000),
  duneExecutionTimeoutMs: readInt('DUNE_EXECUTION_TIMEOUT_MS', 10 * 60 * 1000),
  cmcApiKey,
  cmcGlobalMetricsHistoricalUrl: optional(process.env.CMC_GLOBAL_METRICS_HISTORICAL_URL)
    || 'https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes/historical',
  cmcGlobalMetricsInterval: optional(process.env.CMC_GLOBAL_METRICS_INTERVAL) || '1d',
  tcFeeDashDuneQueryId: optional(process.env.TC_FEE_DASH_DUNE_QUERY_ID) || '7619850',
  tcFeeDashStartDate: optional(process.env.TC_FEE_DASH_START_DATE) || '2022-06-22',
  tcFeeDashEndDate: optional(process.env.TC_FEE_DASH_END_DATE),
  tcFeeDashDaysPerRun: readInt('TC_FEE_DASH_DAYS_PER_RUN', 90),
  tcFeeDashHeadLagDays: readInt('TC_FEE_DASH_HEAD_LAG_DAYS', 1),
  tcFeeDashRequestDelayMs: readInt('TC_FEE_DASH_REQUEST_DELAY_MS', 1000),
  tcFeeDashRateLimitCooldownMs: readInt('TC_FEE_DASH_RATE_LIMIT_COOLDOWN_SECONDS', 60 * 60) * 1000,
  wasmArbEconomicsStartTime: optional(process.env.WASM_ARB_ECONOMICS_START_TIME)
    || '2026-07-27T14:04:45Z',
  wasmArbEconomicsStartHeight: readInt('WASM_ARB_ECONOMICS_START_HEIGHT', 27181679),
  wasmArbEconomicsActionBackfillPages: readInt('WASM_ARB_ECONOMICS_ACTION_BACKFILL_PAGES', 12),
  wasmArbEconomicsActionHeadPages: readInt('WASM_ARB_ECONOMICS_ACTION_HEAD_PAGES', 6),
  wasmArbEconomicsTransferBackfillPages: readInt('WASM_ARB_ECONOMICS_TRANSFER_BACKFILL_PAGES', 12),
  wasmArbEconomicsTransferHeadPages: readInt('WASM_ARB_ECONOMICS_TRANSFER_HEAD_PAGES', 6),
  wasmArbEconomicsNetworkChunks: readInt('WASM_ARB_ECONOMICS_NETWORK_CHUNKS', 3),
  wasmArbEconomicsBlockMaxHeights: readInt('WASM_ARB_ECONOMICS_BLOCK_MAX_HEIGHTS', 80),
  wasmArbEconomicsOracleStartHeight: readInt(
    'WASM_ARB_ECONOMICS_ORACLE_START_HEIGHT',
    27181679
  ),
  wasmArbEconomicsOracleStrideBlocks: readInt(
    'WASM_ARB_ECONOMICS_ORACLE_STRIDE_BLOCKS',
    30
  ),
  wasmArbEconomicsOracleSamplesPerRun: readInt(
    'WASM_ARB_ECONOMICS_ORACLE_SAMPLES_PER_RUN',
    40
  ),
  wasmArbEconomicsOracleGapRetryAttempts: readInt(
    'WASM_ARB_ECONOMICS_ORACLE_GAP_RETRY_ATTEMPTS',
    3
  ),
  wasmArbEconomicsMissingPoolCacheMs: readInt(
    'WASM_ARB_ECONOMICS_MISSING_POOL_CACHE_SECONDS',
    24 * 60 * 60
  ) * 1000,
  wasmArbEconomicsRequestDelayMs: readInt('WASM_ARB_ECONOMICS_REQUEST_DELAY_MS', 75),
  wasmArbEconomicsRetentionDays: readInt('WASM_ARB_ECONOMICS_RETENTION_DAYS', 400),
  wasmArbEconomicsFinCodeIds: readList('WASM_ARB_ECONOMICS_FIN_CODE_IDS', ['180'])
});

export function requireConfig(key) {
  const value = config[key];
  if (!value) {
    throw new Error(`Missing required config: ${key}`);
  }
  return value;
}
