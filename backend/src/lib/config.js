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
    : fallback;

  return [...new Set(values)];
}

const thornodePrimaryUrl = optional(process.env.THORNODE_PRIMARY_URL) || 'https://gateway.liquify.com/chain/thorchain_api';
const thornodeArchiveUrl = optional(process.env.THORNODE_ARCHIVE_URL) || 'https://thornode-archive.ninerealms.com';
const thornodeFallbackUrl = optional(process.env.THORNODE_FALLBACK_URL) || 'https://thornode.thorchain.network';
const midgardUrl = optional(process.env.MIDGARD_URL) || 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
const midgardFallbackUrl = optional(process.env.MIDGARD_FALLBACK_URL) || 'https://midgard.thorchain.network/v2';
const rpcWsUrl = optional(process.env.RPC_WS_URL) || 'wss://gateway.liquify.com/chain/thorchain_rpc/websocket';
const rpcRestUrl = optional(process.env.RPC_REST_URL) || 'https://gateway.liquify.com/chain/thorchain_rpc';
const rpcFallbackRestUrl = optional(process.env.RPC_FALLBACK_REST_URL) || 'https://rpc.thorchain.network';
const rpcArchiveRestUrl = optional(process.env.RPC_ARCHIVE_REST_URL) || 'https://rpc.thorchain.liquify.com';
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
  rpcWsUrls: readList('RPC_WS_URLS', [
    rpcWsUrl,
    'wss://rpc.thorchain.network/websocket'
  ]),
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
  rujiraBaseFeesMidgardMaxPages: readInt('RUJIRA_BASE_FEES_MIDGARD_MAX_PAGES', 10),
  rujiraBaseFeesBlockMaxHeights: readInt('RUJIRA_BASE_FEES_BLOCK_MAX_HEIGHTS', 75),
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
  tcFeeDashRateLimitCooldownMs: readInt('TC_FEE_DASH_RATE_LIMIT_COOLDOWN_SECONDS', 60 * 60) * 1000
});

export function requireConfig(key) {
  const value = config[key];
  if (!value) {
    throw new Error(`Missing required config: ${key}`);
  }
  return value;
}
