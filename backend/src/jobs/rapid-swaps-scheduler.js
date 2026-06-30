import { withAdvisoryLock } from '../db/lock.js';
import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import { isDuneLimitError, summarizeDuneError } from '../shared/dune.js';
import {
  buildRapidSwapCanonicalScanPlan,
  fetchRapidSwapRowsFromDune,
  fetchRapidSwapSourceStatus,
  fetchRapidSwapPriceIndex,
  fetchRapidSwapRows,
  getRapidSwapRateLimitCooldownMs,
  isRapidSwapRateLimitError,
  mergeRapidSwapRowsByTxId,
  resolveRapidSwapHint,
  shouldSkipRapidSwapCanonicalScanForHealthyListener,
  summarizeRapidSwapCanonicalScan
} from '../shared/rapid-swaps.js';
import { mergePendingCandidateBatches } from '../shared/rapid-swap-candidates.js';
import { upsertRapidSwaps } from '../db/rapid-swaps-store.js';

const SYNC_KEY = 'rapid-swaps-canonical';
const FRESH_PENDING_CANDIDATE_RATIO = 0.75;
const LISTENER_HEARTBEAT_GRACE_MS = 3 * 60 * 1000;
const LISTENER_STABLE_UPTIME_MS = 10 * 60 * 1000;

function safeStats(syncState) {
  return syncState?.stats_json && typeof syncState.stats_json === 'object'
    ? syncState.stats_json
    : {};
}

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function statsObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rapidSwapsDuneHeadEndTime() {
  return new Date(Date.now() - Math.max(0, config.rapidSwapsDuneHeadLagHours) * 60 * 60 * 1000);
}

function buildRapidSwapsDuneWindow(syncState) {
  const stats = safeStats(syncState);
  const headEnd = rapidSwapsDuneHeadEndTime();
  const configuredStart = toIsoOrNull(config.rapidSwapsDuneStartTime) || new Date(headEnd.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const nextStart = toIsoOrNull(stats.dune_next_start_time) || configuredStart;
  let start = new Date(nextStart);

  if (!Number.isFinite(start.getTime()) || start >= headEnd) {
    start = new Date(Math.max(
      Date.parse(configuredStart),
      headEnd.getTime() - Math.max(1, config.rapidSwapsDuneDaysPerRun) * 24 * 60 * 60 * 1000
    ));
  }

  const end = new Date(Math.min(
    addDays(start, Math.max(1, config.rapidSwapsDuneDaysPerRun)).getTime(),
    headEnd.getTime()
  ));

  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    nextStartTime: end >= headEnd
      ? new Date(Math.max(
          Date.parse(configuredStart),
          headEnd.getTime() - Math.max(1, config.rapidSwapsDuneDaysPerRun) * 24 * 60 * 60 * 1000
        )).toISOString()
      : end.toISOString(),
    headEndTime: headEnd.toISOString()
  };
}

function getDuneLastScannedAtMs(syncState, stats) {
  const duneLastScannedAtMs = timestampMs(stats?.dune_last_scanned_at);
  if (duneLastScannedAtMs > 0) {
    return duneLastScannedAtMs;
  }

  const duneLastAttemptedAtMs = timestampMs(stats?.dune_last_attempted_at);
  if (duneLastAttemptedAtMs > 0) {
    return duneLastAttemptedAtMs;
  }

  if (!stats?.live_tail) {
    return timestampMs(syncState?.last_scanned_at);
  }

  return 0;
}

function buildHybridSourceStatus({ dune = null, liveTail = null } = {}) {
  const liveStatus = String(liveTail?.status || '');
  const duneStatus = String(dune?.status || '');
  return {
    status: liveStatus === 'error'
      || liveStatus === 'rate_limited'
      || duneStatus === 'error'
      || duneStatus === 'rate_limited'
      ? 'degraded'
      : 'active',
    provider: 'hybrid',
    canonical_provider: 'dune',
    live_provider: 'midgard',
    observed_at: new Date().toISOString(),
    dune,
    live_tail: liveTail || null
  };
}

async function runRapidSwapsLiveTail(client, syncState, previousStats) {
  const pages = Math.max(0, Math.trunc(Number(config.rapidSwapsLiveTailPages) || 0));
  const intervalMs = Math.max(0, Math.trunc(Number(config.rapidSwapsLiveTailIntervalMs) || 0));
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const previousLiveTail = statsObject(previousStats?.live_tail);

  if (pages <= 0) {
    return {
      changed: false,
      ran: false,
      liveTail: {
        ...previousLiveTail,
        status: 'disabled',
        provider: 'midgard',
        mode: 'live_tail',
        skipped: true,
        skip_reason: 'disabled'
      }
    };
  }

  const rateLimitedUntilMs = timestampMs(previousLiveTail.rate_limited_until);
  if (rateLimitedUntilMs > nowMs) {
    return {
      changed: false,
      ran: false,
      liveTail: {
        ...previousLiveTail,
        status: 'rate_limited',
        provider: 'midgard',
        mode: 'live_tail',
        skipped: true,
        skip_reason: 'rate_limited',
        next_scan_at: new Date(rateLimitedUntilMs).toISOString()
      }
    };
  }

  const lastLiveScanAtMs = timestampMs(previousLiveTail.last_scanned_at);
  if (intervalMs > 0 && lastLiveScanAtMs > 0 && nowMs - lastLiveScanAtMs < intervalMs) {
    return {
      changed: false,
      ran: false,
      liveTail: {
        ...previousLiveTail,
        status: previousLiveTail.status || 'active',
        provider: 'midgard',
        mode: 'live_tail',
        skipped: true,
        skip_reason: 'scan_interval',
        next_scan_at: new Date(lastLiveScanAtMs + intervalMs).toISOString()
      }
    };
  }

  try {
    const [priceIndex, knownTxIds] = await Promise.all([
      fetchRapidSwapPriceIndex(),
      loadRecentRapidSwapTxIds(client)
    ]);
    const scan = await fetchRapidSwapRows({
      maxPages: pages,
      knownTxIds,
      priceIndex,
      observedAt: nowIso
    });
    await upsertRapidSwaps(client, scan.rows);

    const liveTail = {
      status: 'active',
      provider: 'midgard',
      mode: 'live_tail',
      last_scanned_at: scan.observedAt || nowIso,
      observed_at: scan.observedAt || nowIso,
      scanned_pages: scan.scannedPages,
      scanned_actions: scan.scannedActions,
      rapid_swaps_upserted: scan.rows.length,
      highest_height_seen: scan.highestHeight,
      lowest_height_seen: scan.lowestHeight,
      stopped_early: Boolean(scan.stoppedEarly),
      reached_stop_height: Boolean(scan.reachedStopHeight),
      next_page_token: scan.nextPageToken || '',
      next_scan_at: intervalMs > 0 ? new Date(Date.now() + intervalMs).toISOString() : '',
      rate_limited_until: null,
      error: null
    };

    return {
      changed: true,
      ran: true,
      liveTail,
      highestHeight: scan.highestHeight,
      lastScannedAt: liveTail.last_scanned_at
    };
  } catch (error) {
    const rateLimited = isRapidSwapRateLimitError(error);
    const cooldownMs = rateLimited
      ? getRapidSwapRateLimitCooldownMs(error, config.rapidSwapsRateLimitCooldownMs)
      : 0;
    const rateLimitedUntil = rateLimited
      ? new Date(nowMs + cooldownMs).toISOString()
      : null;
    const liveTail = {
      ...previousLiveTail,
      status: rateLimited ? 'rate_limited' : 'error',
      provider: 'midgard',
      mode: 'live_tail',
      skipped: true,
      skip_reason: rateLimited ? 'rate_limited' : 'provider_error',
      last_error_at: nowIso,
      error: error.message || 'Rapid swap live tail failed',
      rate_limited_until: rateLimitedUntil,
      next_scan_at: rateLimitedUntil || (intervalMs > 0 ? new Date(nowMs + intervalMs).toISOString() : '')
    };

    return {
      changed: true,
      ran: false,
      liveTail,
      error
    };
  }
}

async function runRapidSwapsDuneScheduler(client, jobId, syncState) {
  const previousStats = safeStats(syncState);
  const nextStats = { ...previousStats };
  if (!nextStats.dune_last_scanned_at && syncState?.last_scanned_at && !previousStats.live_tail) {
    nextStats.dune_last_scanned_at = toIsoOrNull(syncState.last_scanned_at);
  }

  let lastScannedHeight = Number(syncState?.last_scanned_height || 0);
  let lastScannedAt = toIsoOrNull(syncState?.last_scanned_at) || '';
  const liveTailResult = await runRapidSwapsLiveTail(client, syncState, nextStats);
  nextStats.live_tail = liveTailResult.liveTail;
  if (liveTailResult.lastScannedAt) {
    lastScannedAt = liveTailResult.lastScannedAt;
  }
  if (liveTailResult.highestHeight) {
    lastScannedHeight = Math.max(lastScannedHeight, liveTailResult.highestHeight);
  }

  if (!config.duneApiKey || !config.rapidSwapsDuneQueryId) {
    const canonicalSkipReason = !config.duneApiKey ? 'missing_dune_api_key' : 'missing_dune_rapid_swaps_query_id';
    const sourceStatus = buildHybridSourceStatus({
      dune: {
        status: 'not_configured',
        query_id: config.rapidSwapsDuneQueryId || '',
        skip_reason: canonicalSkipReason
      },
      liveTail: liveTailResult.liveTail
    });
    Object.assign(nextStats, {
      provider: 'hybrid',
      canonical_provider: 'dune',
      live_provider: 'midgard',
      dune_query_id: config.rapidSwapsDuneQueryId || '',
      source_status: sourceStatus
    });

    if (liveTailResult.changed) {
      await saveSyncState(client, {
        last_scanned_height: lastScannedHeight,
        last_scanned_at: lastScannedAt || new Date().toISOString(),
        stats_json: nextStats
      });
    }

    const payload = {
      job_name: 'rapid-swaps-recent-actions',
      finished_at: new Date().toISOString(),
      status: 'success',
      stats_json: {
        provider: 'hybrid',
        canonical_provider: 'dune',
        live_provider: 'midgard',
        skipped: !liveTailResult.ran,
        skip_reason: liveTailResult.ran ? canonicalSkipReason : liveTailResult.liveTail?.skip_reason || canonicalSkipReason,
        canonical_skipped: true,
        canonical_skip_reason: canonicalSkipReason,
        live_tail: liveTailResult.liveTail,
        source_status: sourceStatus
      }
    };
    await completeJobRun(client, jobId, payload);
    return {
      ok: true,
      stats: payload.stats_json
    };
  }

  const lastScannedAtMs = getDuneLastScannedAtMs(syncState, nextStats);
  if (
    lastScannedAtMs > 0 &&
    Date.now() - lastScannedAtMs < config.rapidSwapsDuneScanIntervalMs
  ) {
    const nextScanAt = new Date(lastScannedAtMs + config.rapidSwapsDuneScanIntervalMs).toISOString();
    const sourceStatus = buildHybridSourceStatus({
      dune: {
        status: 'waiting_for_interval',
        query_id: config.rapidSwapsDuneQueryId,
        last_scanned_at: nextStats.dune_last_scanned_at || '',
        next_scan_at: nextScanAt
      },
      liveTail: liveTailResult.liveTail
    });
    Object.assign(nextStats, {
      provider: 'hybrid',
      canonical_provider: 'dune',
      live_provider: 'midgard',
      dune_query_id: config.rapidSwapsDuneQueryId,
      dune_next_scan_at: nextScanAt,
      source_status: sourceStatus
    });

    if (liveTailResult.changed) {
      await saveSyncState(client, {
        last_scanned_height: lastScannedHeight,
        last_scanned_at: lastScannedAt || new Date().toISOString(),
        stats_json: nextStats
      });
    }

    const { rows: pendingCountRows } = await client.query(
      `select count(*)::bigint as count
       from rapid_swap_candidates
       where status = $1`,
      ['pending']
    );
    const pendingCount = Number(pendingCountRows[0]?.count) || 0;
    const payload = {
      job_name: 'rapid-swaps-recent-actions',
      finished_at: new Date().toISOString(),
      status: 'success',
      stats_json: {
        provider: 'hybrid',
        canonical_provider: 'dune',
        live_provider: 'midgard',
        skipped: !liveTailResult.ran,
        skip_reason: liveTailResult.ran ? 'dune_scan_interval' : 'scan_interval',
        canonical_skipped: true,
        canonical_skip_reason: 'scan_interval',
        next_scan_at: liveTailResult.liveTail?.next_scan_at || nextScanAt,
        dune_next_scan_at: nextScanAt,
        live_tail: liveTailResult.liveTail,
        pending_candidates_remaining: pendingCount,
        source_status: sourceStatus
      }
    };
    await completeJobRun(client, jobId, payload);
    return {
      ok: true,
      stats: payload.stats_json
    };
  }

  const window = buildRapidSwapsDuneWindow(syncState);
  let duneResult;
  try {
    duneResult = await fetchRapidSwapRowsFromDune({
      startTime: window.startTime,
      endTime: window.endTime,
      limit: config.rapidSwapsDuneLimit
    });
    await upsertRapidSwaps(client, duneResult.rows);
  } catch (duneError) {
    const finishedAt = new Date().toISOString();
    const nextScanAt = new Date(Date.now() + config.rapidSwapsDuneScanIntervalMs).toISOString();
    const duneErrorSummary = summarizeDuneError(duneError);
    const canonicalSkipReason = isDuneLimitError(duneError) ? 'dune_limit_error' : 'dune_error';
    const duneStatus = {
      status: 'error',
      query_id: config.rapidSwapsDuneQueryId,
      start_time: window.startTime,
      end_time: window.endTime,
      next_start_time: window.startTime,
      head_end_time: window.headEndTime,
      next_scan_at: nextScanAt,
      last_error_at: finishedAt,
      skip_reason: canonicalSkipReason,
      error: duneErrorSummary
    };
    const sourceStatus = buildHybridSourceStatus({
      dune: duneStatus,
      liveTail: liveTailResult.liveTail
    });
    Object.assign(nextStats, {
      provider: 'hybrid',
      canonical_provider: 'dune',
      live_provider: 'midgard',
      dune_query_id: config.rapidSwapsDuneQueryId,
      dune_last_attempted_at: finishedAt,
      dune_next_scan_at: nextScanAt,
      dune_window_start_time: window.startTime,
      dune_window_end_time: window.endTime,
      dune_next_start_time: window.startTime,
      dune_head_end_time: window.headEndTime,
      dune_error: duneErrorSummary,
      source_status: sourceStatus
    });

    await saveSyncState(client, {
      last_scanned_height: lastScannedHeight,
      last_scanned_at: lastScannedAt || toIsoOrNull(syncState?.last_scanned_at) || finishedAt,
      stats_json: nextStats
    });

    const { rows: pendingCountRows } = await client.query(
      `select count(*)::bigint as count
       from rapid_swap_candidates
       where status = $1`,
      ['pending']
    );
    const pendingCount = Number(pendingCountRows[0]?.count) || 0;
    const liveTailUpserted = liveTailResult.ran ? Number(liveTailResult.liveTail?.rapid_swaps_upserted || 0) : 0;
    const payload = {
      job_name: 'rapid-swaps-recent-actions',
      finished_at: finishedAt,
      status: 'success',
      stats_json: {
        provider: 'hybrid',
        canonical_provider: 'dune',
        live_provider: 'midgard',
        skipped: liveTailUpserted <= 0,
        skip_reason: liveTailResult.ran ? canonicalSkipReason : liveTailResult.liveTail?.skip_reason || canonicalSkipReason,
        canonical_skipped: true,
        canonical_skip_reason: canonicalSkipReason,
        dune_query_id: config.rapidSwapsDuneQueryId,
        dune_last_attempted_at: finishedAt,
        dune_next_scan_at: nextScanAt,
        dune_window_start_time: window.startTime,
        dune_window_end_time: window.endTime,
        dune_next_start_time: window.startTime,
        dune_head_end_time: window.headEndTime,
        dune_error: duneErrorSummary,
        rapid_swaps_upserted: liveTailUpserted,
        canonical_rapid_swaps_upserted: 0,
        live_tail: liveTailResult.liveTail,
        pending_candidates_remaining: pendingCount,
        source_status: sourceStatus
      }
    };
    await completeJobRun(client, jobId, payload);
    return {
      ok: true,
      stats: payload.stats_json
    };
  }

  const finishedAt = new Date().toISOString();
  const duneStatus = {
    status: 'active',
    query_id: config.rapidSwapsDuneQueryId,
    execution_id: duneResult.executionId,
    start_time: window.startTime,
    end_time: window.endTime,
    next_start_time: window.nextStartTime,
    head_end_time: window.headEndTime,
    scanned_rows: duneResult.scannedActions,
    accepted_rows: duneResult.rows.length,
    observed_at: duneResult.observedAt,
    last_scanned_at: finishedAt
  };
  const sourceStatus = buildHybridSourceStatus({
    dune: duneStatus,
    liveTail: liveTailResult.liveTail
  });

  await saveSyncState(client, {
    last_scanned_height: Math.max(lastScannedHeight, duneResult.highestHeight || 0),
    last_scanned_at: liveTailResult.lastScannedAt || finishedAt,
    stats_json: mergeSourceStatusIntoStats(nextStats, sourceStatus, {
      provider: 'hybrid',
      canonical_provider: 'dune',
      live_provider: 'midgard',
      dune_query_id: config.rapidSwapsDuneQueryId,
      dune_execution_id: duneResult.executionId,
      dune_last_scanned_at: finishedAt,
      dune_window_start_time: window.startTime,
      dune_window_end_time: window.endTime,
      dune_next_start_time: window.nextStartTime,
      dune_head_end_time: window.headEndTime,
      dune_scanned_rows: duneResult.scannedActions,
      dune_accepted_rows: duneResult.rows.length,
      highest_height_seen: duneResult.highestHeight || previousStats.highest_height_seen || 0,
      lowest_height_seen: duneResult.lowestHeight || previousStats.lowest_height_seen || 0,
      rate_limited_until: null,
      source_idle_until: null
    })
  });

  const { rows: pendingCountRows } = await client.query(
    `select count(*)::bigint as count
     from rapid_swap_candidates
     where status = $1`,
    ['pending']
  );
  const pendingCount = Number(pendingCountRows[0]?.count) || 0;

  const payload = {
    job_name: 'rapid-swaps-recent-actions',
    finished_at: new Date().toISOString(),
    status: 'success',
    stats_json: {
      provider: 'hybrid',
      canonical_provider: 'dune',
      live_provider: 'midgard',
      dune_query_id: config.rapidSwapsDuneQueryId,
      dune_execution_id: duneResult.executionId,
      dune_last_scanned_at: finishedAt,
      dune_window_start_time: window.startTime,
      dune_window_end_time: window.endTime,
      dune_next_start_time: window.nextStartTime,
      dune_head_end_time: window.headEndTime,
      scanned_actions: duneResult.scannedActions,
      rapid_swaps_upserted: duneResult.rows.length + (liveTailResult.ran ? Number(liveTailResult.liveTail?.rapid_swaps_upserted || 0) : 0),
      canonical_rapid_swaps_upserted: duneResult.rows.length,
      live_tail: liveTailResult.liveTail,
      pending_candidates_remaining: pendingCount,
      highest_height_seen: duneResult.highestHeight,
      lowest_height_seen: duneResult.lowestHeight,
      source_status: sourceStatus
    }
  };

  await completeJobRun(client, jobId, payload);
  return {
    ok: true,
    stats: payload.stats_json
  };
}

function getSourceHeadHeight(sourceStatus) {
  return Math.max(
    0,
    Math.trunc(Number(sourceStatus?.midgard?.latest_swap_action?.height || 0))
  );
}

function getKnownSourceHeadHeight(syncState) {
  const stats = safeStats(syncState);
  return Math.max(
    Number(syncState?.last_scanned_height || 0),
    Number(stats.highest_height_seen || 0),
    Number(stats.source_status?.midgard?.latest_swap_action?.height || 0)
  );
}

function isSourceIdleForKnownHead(sourceStatus, syncState) {
  const sourceHeadHeight = getSourceHeadHeight(sourceStatus);
  if (sourceStatus?.status !== 'halted_idle' || sourceHeadHeight <= 0) {
    return false;
  }

  return getKnownSourceHeadHeight(syncState) >= sourceHeadHeight;
}

function mergeSourceStatusIntoStats(stats, sourceStatus, extra = {}) {
  return {
    ...(stats && typeof stats === 'object' ? stats : {}),
    ...(sourceStatus ? { source_status: sourceStatus } : {}),
    ...extra
  };
}

function computeRetryDelaySeconds(attempt) {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(30 * 60, 60 * Math.pow(2, Math.min(normalizedAttempt - 1, 5)));
}

async function insertJobRun(client, payload) {
  const { rows } = await client.query(
    `insert into rapid_swap_job_runs
      (job_name, started_at, status, error, stats_json)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      payload.job_name,
      payload.started_at || new Date().toISOString(),
      payload.status,
      payload.error || null,
      payload.stats_json || {}
    ]
  );

  return String(rows[0].id);
}

async function completeJobRun(client, jobId, payload) {
  await client.query(
    `update rapid_swap_job_runs
     set finished_at = $2,
         status = $3,
         error = $4,
         stats_json = $5
     where id = $1`,
    [
      jobId,
      payload.finished_at || new Date().toISOString(),
      payload.status,
      payload.error || null,
      payload.stats_json || {}
    ]
  );
}

async function loadSyncState(client) {
  const { rows } = await client.query(
    `select sync_key, last_scanned_height, last_scanned_at, stats_json
     from rapid_swap_sync_state
     where sync_key = $1
     limit 1`,
    [SYNC_KEY]
  );

  return rows[0] || null;
}

async function saveSyncState(client, payload) {
  await upsertRows(client, 'rapid_swap_sync_state', [
    {
      sync_key: SYNC_KEY,
      last_scanned_height: Number(payload.last_scanned_height || 0),
      last_scanned_at: payload.last_scanned_at || new Date().toISOString(),
      stats_json: payload.stats_json || {}
    }
  ], {
    conflictColumns: ['sync_key'],
    jsonColumns: ['stats_json']
  });
}

async function loadWsListenerState(client) {
  const { rows } = await client.query(
    `select finished_at, status, stats_json
     from rapid_swap_job_runs
     where job_name = $1
     order by started_at desc
     limit 1`,
    ['rapid-swaps-ws-listener']
  );

  return rows[0] || null;
}

async function loadRecentRapidSwapTxIds(client, limit = 2000) {
  const { rows } = await client.query(
    `select tx_id
     from rapid_swaps
     order by action_date desc
     limit $1`,
    [Math.max(1, Math.trunc(Number(limit) || 2000))]
  );

  return new Set((rows || []).map((row) => String(row.tx_id || '')).filter(Boolean));
}

function buildSchedulerScanPlan(syncState, wsListenerState) {
  const nowMs = Date.now();
  const hasCanonicalState = Number(syncState?.last_scanned_height || 0) > 0;
  const canonicalLagging = Boolean(syncState?.stats_json?.lagging);

  if (hasCanonicalState && !canonicalLagging && shouldSkipRapidSwapCanonicalScanForHealthyListener(wsListenerState, {
    nowMs,
    heartbeatGraceMs: LISTENER_HEARTBEAT_GRACE_MS,
    blockProgressGraceMs: config.rapidSwapsListenerBlockStallMs,
    stableUptimeMs: LISTENER_STABLE_UPTIME_MS
  })) {
    return {
      shouldScan: false,
      skipReason: 'listener_healthy',
      nextScanAt: new Date(nowMs + config.rapidSwapsCanonicalScanIntervalMs).toISOString(),
      head: null,
      catchup: null
    };
  }

  return buildRapidSwapCanonicalScanPlan({
    syncState,
    nowMs,
    overlapBlocks: config.rapidSwapsHeightOverlapBlocks,
    headMaxPages: config.rapidSwapsMaxPages,
    catchupMaxPages: config.rapidSwapsCatchupMaxPages,
    normalHeadPages: 1,
    laggingHeadPages: 1,
    catchupPages: 1,
    scanIntervalMs: config.rapidSwapsCanonicalScanIntervalMs
  });
}

async function loadPendingCandidates(client) {
  const now = new Date().toISOString();
  const batchSize = Math.max(1, config.rapidSwapsPendingCandidateBatch);
  const freshLimit = Math.max(1, Math.ceil(batchSize * FRESH_PENDING_CANDIDATE_RATIO));
  const agedLimit = Math.max(0, batchSize - freshLimit);

  const { rows: freshRows } = await client.query(
    `select *
     from rapid_swap_candidates
     where status = $1
       and next_retry_at <= $2
     order by observed_height desc, last_seen_at desc, first_seen_at desc
     limit $3`,
    [
      'pending',
      now,
      freshLimit
    ]
  );

  const { rows: agedRows } = agedLimit > 0
    ? await client.query(
        `select *
         from rapid_swap_candidates
         where status = $1
           and next_retry_at <= $2
         order by first_seen_at asc
         limit $3`,
        [
          'pending',
          now,
          agedLimit
        ]
      )
    : { rows: [] };

  const selected = mergePendingCandidateBatches([freshRows, agedRows], batchSize);
  if (selected.length >= batchSize) {
    return {
      now,
      candidates: selected
    };
  }

  const excludedHintKeys = selected.map((row) => String(row.hint_key || '')).filter(Boolean);
  const remainingLimit = Math.max(0, batchSize - selected.length);
  if (remainingLimit === 0) {
    return {
      now,
      candidates: selected
    };
  }

  const fillerQuery = excludedHintKeys.length > 0
    ? await client.query(
        `select *
         from rapid_swap_candidates
         where status = $1
           and next_retry_at <= $2
           and not (hint_key = any($3::text[]))
         order by observed_height desc, last_seen_at desc, first_seen_at asc
         limit $4`,
        [
          'pending',
          now,
          excludedHintKeys,
          remainingLimit
        ]
      )
    : { rows: [] };

  return {
    now,
    candidates: mergePendingCandidateBatches([selected, fillerQuery.rows], batchSize)
  };
}

async function countReadyPendingCandidates(client) {
  const { rows } = await client.query(
    `select count(*)::bigint as count
     from rapid_swap_candidates
     where status = $1
       and next_retry_at <= $2`,
    [
      'pending',
      new Date().toISOString()
    ]
  );

  return Number(rows[0]?.count) || 0;
}

async function resolvePendingCandidates(client, priceIndex) {
  const { now, candidates } = await loadPendingCandidates(client);

  const updates = [];
  const upsertRowsForRapidSwaps = [];
  let resolved = 0;
  let errored = 0;
  let deferred = 0;

  for (const candidate of candidates || []) {
    const attempts = Number(candidate.attempts || 0) + 1;
    const result = await resolveRapidSwapHint(candidate, {
      priceIndex,
      observedAt: candidate.first_seen_at || now
    }).catch((resolveError) => ({
      row: null,
      hint: candidate,
      resolvedBy: '',
      error: resolveError
    }));

    const hint = result.hint || candidate;
    if (result.row) {
      upsertRowsForRapidSwaps.push(result.row);
      updates.push({
        hint_key: candidate.hint_key,
        status: 'resolved',
        attempts,
        tx_id: hint.tx_id || candidate.tx_id || '',
        memo: hint.memo || candidate.memo || '',
        source_address: hint.source_address || candidate.source_address || '',
        observed_height: Number(hint.observed_height || candidate.observed_height || 0),
        last_height: Number(hint.last_height || candidate.last_height || 0),
        last_seen_at: now,
        next_retry_at: now,
        resolved_tx_id: String(result.row.tx_id || ''),
        resolved_at: now,
        last_error: null,
        raw_hint: hint.raw_hint || candidate.raw_hint || {}
      });
      resolved += 1;
      continue;
    }

    if (result.terminal) {
      updates.push({
        hint_key: candidate.hint_key,
        status: 'error',
        attempts,
        tx_id: hint.tx_id || candidate.tx_id || '',
        memo: hint.memo || candidate.memo || '',
        source_address: hint.source_address || candidate.source_address || '',
        observed_height: Number(hint.observed_height || candidate.observed_height || 0),
        last_height: Number(hint.last_height || candidate.last_height || 0),
        last_seen_at: now,
        next_retry_at: now,
        resolved_tx_id: String(candidate.resolved_tx_id || ''),
        resolved_at: candidate.resolved_at || null,
        last_error: result.error?.message || 'Direct THORNode reconciliation shows this swap is not rapid',
        raw_hint: hint.raw_hint || candidate.raw_hint || {}
      });
      errored += 1;
      continue;
    }

    const shouldError = attempts >= Math.max(1, config.rapidSwapsMaxCandidateAttempts);
    updates.push({
      hint_key: candidate.hint_key,
      status: shouldError ? 'error' : 'pending',
      attempts,
      tx_id: hint.tx_id || candidate.tx_id || '',
      memo: hint.memo || candidate.memo || '',
      source_address: hint.source_address || candidate.source_address || '',
      observed_height: Number(hint.observed_height || candidate.observed_height || 0),
      last_height: Number(hint.last_height || candidate.last_height || 0),
      last_seen_at: now,
      next_retry_at: shouldError
        ? now
        : new Date(Date.now() + computeRetryDelaySeconds(attempts) * 1000).toISOString(),
      resolved_tx_id: String(candidate.resolved_tx_id || ''),
      resolved_at: candidate.resolved_at || null,
      last_error: result.error?.message || 'Unable to resolve rapid swap via tx, address, or recent scan',
      raw_hint: hint.raw_hint || candidate.raw_hint || {}
    });

    if (shouldError) {
      errored += 1;
    } else {
      deferred += 1;
    }
  }

  if (updates.length > 0) {
    await upsertRows(client, 'rapid_swap_candidates', updates, {
      conflictColumns: ['hint_key'],
      jsonColumns: ['raw_hint']
    });
  }

  return {
    pendingLoaded: (candidates || []).length,
    resolved,
    errored,
    deferred,
    upsertRows: upsertRowsForRapidSwaps
  };
}

export async function runRapidSwapsScheduler() {
  return withAdvisoryLock('boonetools:rapid-swaps-scheduler', async (client) => {
    let jobId = '';
    let syncState = null;

    try {
      jobId = await insertJobRun(client, {
        job_name: 'rapid-swaps-recent-actions',
        status: 'running'
      });

      syncState = await loadSyncState(client);
      if (config.rapidSwapsDuneQueryId) {
        return runRapidSwapsDuneScheduler(client, jobId, syncState);
      }
      const wsListenerState = await loadWsListenerState(client);
      const scanPlan = buildSchedulerScanPlan(syncState, wsListenerState);
      let effectiveScanPlan = scanPlan;
      let sourceIdleStats = null;

      const readyPendingCount = await countReadyPendingCandidates(client);

      if (!scanPlan.shouldScan && readyPendingCount === 0) {
        const payload = {
          job_name: 'rapid-swaps-recent-actions',
          finished_at: new Date().toISOString(),
          status: 'success',
          stats_json: {
            skipped: true,
            skip_reason: scanPlan.skipReason,
            next_scan_at: scanPlan.nextScanAt,
            pending_candidates_ready: readyPendingCount,
            source_status: safeStats(syncState).source_status || null
          }
        };

        await completeJobRun(client, jobId, payload);

        return {
          ok: true,
          stats: payload.stats_json
        };
      }

      let sourceStatus = null;
      let sourceStatusFresh = false;
      if (scanPlan.shouldScan) {
        if (scanPlan.skipReason === 'source_idle_catchup') {
          const stats = safeStats(syncState);
          sourceStatus = stats.source_status || null;
          sourceIdleStats = {
            source_idle_at: stats.source_idle_at || null,
            source_idle_until: stats.source_idle_until || null,
            source_idle_reason: stats.source_idle_reason || 'chain_halted_action_head_unchanged'
          };
        } else {
          sourceStatus = await fetchRapidSwapSourceStatus();
          sourceStatusFresh = true;
        }

        if (sourceStatus?.midgard?.status === 'rate_limited') {
          const now = new Date().toISOString();
          const rateLimitedUntil = new Date(Date.now() + config.rapidSwapsRateLimitCooldownMs).toISOString();
          const previousStats = safeStats(syncState);
          await saveSyncState(client, {
            last_scanned_height: Number(syncState?.last_scanned_height || 0),
            last_scanned_at: syncState?.last_scanned_at || now,
            stats_json: mergeSourceStatusIntoStats(previousStats, sourceStatus, {
              rate_limited_at: now,
              rate_limited_until: rateLimitedUntil,
              rate_limit_error: sourceStatus.midgard.error || 'Rapid swap provider rate limit'
            })
          });

          const payload = {
            job_name: 'rapid-swaps-recent-actions',
            finished_at: now,
            status: 'success',
            stats_json: {
              skipped: true,
              skip_reason: 'rate_limited',
              rate_limited_until: rateLimitedUntil,
              cooldown_seconds: Math.round(config.rapidSwapsRateLimitCooldownMs / 1000),
              pending_candidates_ready: readyPendingCount,
              source_status: sourceStatus
            }
          };

          await completeJobRun(client, jobId, payload);

          return {
            ok: true,
            stats: payload.stats_json
          };
        }

        if (sourceStatusFresh && readyPendingCount === 0 && isSourceIdleForKnownHead(sourceStatus, syncState)) {
          const now = new Date().toISOString();
          const sourceIdleUntil = new Date(Date.now() + config.rapidSwapsSourceIdleCooldownMs).toISOString();
          sourceIdleStats = {
            source_idle_at: now,
            source_idle_until: sourceIdleUntil,
            source_idle_reason: 'chain_halted_action_head_unchanged'
          };

          if (scanPlan.catchup) {
            effectiveScanPlan = {
              ...scanPlan,
              skipReason: 'source_idle_catchup',
              nextScanAt: '',
              head: null
            };
          } else {
            const previousStats = safeStats(syncState);
            await saveSyncState(client, {
              last_scanned_height: Number(syncState?.last_scanned_height || 0),
              last_scanned_at: now,
              stats_json: mergeSourceStatusIntoStats(previousStats, sourceStatus, sourceIdleStats)
            });

            const payload = {
              job_name: 'rapid-swaps-recent-actions',
              finished_at: now,
              status: 'success',
              stats_json: {
                skipped: true,
                skip_reason: 'source_idle',
                source_idle_until: sourceIdleUntil,
                cooldown_seconds: Math.round(config.rapidSwapsSourceIdleCooldownMs / 1000),
                pending_candidates_ready: readyPendingCount,
                source_status: sourceStatus
              }
            };

            await completeJobRun(client, jobId, payload);

            return {
              ok: true,
              stats: payload.stats_json
            };
          }
        }

        if (sourceIdleStats?.source_idle_until && !sourceStatus) {
          sourceStatus = safeStats(syncState).source_status || null;
        }
      }

      if (sourceIdleStats?.source_idle_until && !effectiveScanPlan.catchup && readyPendingCount === 0) {
        const now = new Date().toISOString();
        const previousStats = safeStats(syncState);
        await saveSyncState(client, {
          last_scanned_height: Number(syncState?.last_scanned_height || 0),
          last_scanned_at: now,
          stats_json: mergeSourceStatusIntoStats(previousStats, sourceStatus, sourceIdleStats)
        });

        const payload = {
          job_name: 'rapid-swaps-recent-actions',
          finished_at: now,
          status: 'success',
          stats_json: {
            skipped: true,
            skip_reason: 'source_idle',
            source_idle_until: sourceIdleStats.source_idle_until,
            cooldown_seconds: Math.round(config.rapidSwapsSourceIdleCooldownMs / 1000),
            pending_candidates_ready: readyPendingCount,
            source_status: sourceStatus
          }
        };

        await completeJobRun(client, jobId, payload);

        return {
          ok: true,
          stats: payload.stats_json
        };
      }

      const priceIndex = await fetchRapidSwapPriceIndex();

      const knownTxIds = await loadRecentRapidSwapTxIds(client);

      const pendingResolution = await resolvePendingCandidates(client, priceIndex);
      await upsertRapidSwaps(client, pendingResolution.upsertRows);

      const headScan = effectiveScanPlan.shouldScan && effectiveScanPlan.head
        ? await fetchRapidSwapRows({
            maxPages: effectiveScanPlan.head.maxPages,
            knownTxIds,
            stopBelowHeight: effectiveScanPlan.head.stopBelowHeight,
            priceIndex
          })
        : null;

      const catchupScan = effectiveScanPlan.catchup
        && (!effectiveScanPlan.head || (headScan && !headScan.reachedStopHeight && !headScan.stoppedEarly))
        ? await fetchRapidSwapRows({
            maxPages: effectiveScanPlan.catchup.maxPages,
            nextPageToken: effectiveScanPlan.catchup.nextPageToken,
            stopBelowHeight: effectiveScanPlan.catchup.stopBelowHeight,
            priceIndex
          })
        : null;

      const canonicalRowsToUpsert = mergeRapidSwapRowsByTxId(
        headScan?.rows || [],
        catchupScan?.rows || []
      );
      await upsertRapidSwaps(client, canonicalRowsToUpsert);

      const scanSummary = headScan || catchupScan
        ? summarizeRapidSwapCanonicalScan({
          syncState,
            plan: effectiveScanPlan,
            headScan,
            catchupScan
          })
        : null;

      if (scanSummary) {
        const statsExtra = sourceIdleStats?.source_idle_until
          ? {
              ...sourceIdleStats,
              rate_limited_until: null
            }
          : {
              source_idle_until: null,
              rate_limited_until: null
            };

        await saveSyncState(client, {
          last_scanned_height: Number(scanSummary.lastScannedHeight || 0),
          last_scanned_at: new Date().toISOString(),
          stats_json: mergeSourceStatusIntoStats(scanSummary.stats, sourceStatus, statsExtra)
        });
      }

      const { rows: pendingCountRows } = await client.query(
        `select count(*)::bigint as count
         from rapid_swap_candidates
         where status = $1`,
        ['pending']
      );
      const pendingCount = Number(pendingCountRows[0]?.count) || 0;

      const payload = {
        job_name: 'rapid-swaps-recent-actions',
        finished_at: new Date().toISOString(),
        status: 'success',
        stats_json: {
          pending_candidates_loaded: pendingResolution.pendingLoaded,
          candidates_resolved: pendingResolution.resolved,
          candidates_deferred: pendingResolution.deferred,
          candidates_errored: pendingResolution.errored,
          pending_candidates_remaining: pendingCount,
          skipped: !effectiveScanPlan.shouldScan,
          skip_reason: effectiveScanPlan.skipReason,
          next_scan_at: effectiveScanPlan.nextScanAt,
          scan_stop_below_height: effectiveScanPlan.head?.stopBelowHeight || 0,
          scan_head_budget_pages: effectiveScanPlan.head?.maxPages || 0,
          scan_catchup_budget_pages: effectiveScanPlan.catchup?.maxPages || 0,
          scan_reached_floor: Boolean(headScan?.reachedStopHeight),
          scan_lagging: Boolean(scanSummary?.lagging),
          highest_height_seen: headScan?.highestHeight || catchupScan?.highestHeight || 0,
          lowest_height_seen: headScan?.lowestHeight || catchupScan?.lowestHeight || 0,
          next_page_token: scanSummary?.stats?.next_page_token || '',
          scanned_pages: Number(headScan?.scannedPages || 0) + Number(catchupScan?.scannedPages || 0),
          scanned_actions: Number(headScan?.scannedActions || 0) + Number(catchupScan?.scannedActions || 0),
          catchup_scanned_pages: Number(catchupScan?.scannedPages || 0),
          catchup_scanned_actions: Number(catchupScan?.scannedActions || 0),
          rapid_swaps_upserted: pendingResolution.upsertRows.length + canonicalRowsToUpsert.length,
          observed_at: headScan?.observedAt || catchupScan?.observedAt || '',
          stopped_early: Boolean(headScan?.stoppedEarly),
          catchup_active: Boolean(effectiveScanPlan.catchup),
          catchup_reached_floor: Boolean(catchupScan?.reachedStopHeight),
          head_skipped_source_idle: Boolean(effectiveScanPlan.catchup && !effectiveScanPlan.head && sourceIdleStats?.source_idle_until),
          source_idle_until: sourceIdleStats?.source_idle_until || null,
          source_status: sourceStatus
        }
      };

      await completeJobRun(client, jobId, payload);

      return {
        ok: true,
        stats: payload.stats_json
      };
    } catch (error) {
      if (isRapidSwapRateLimitError(error)) {
        const cooldownMs = getRapidSwapRateLimitCooldownMs(error, config.rapidSwapsRateLimitCooldownMs);
        const rateLimitedAt = new Date().toISOString();
        const rateLimitedUntil = new Date(Date.now() + cooldownMs).toISOString();
        const previousStats = safeStats(syncState);

        await saveSyncState(client, {
          last_scanned_height: Number(syncState?.last_scanned_height || 0),
          last_scanned_at: syncState?.last_scanned_at || rateLimitedAt,
          stats_json: mergeSourceStatusIntoStats(previousStats, null, {
            rate_limited_at: rateLimitedAt,
            rate_limited_until: rateLimitedUntil,
            rate_limit_error: error.message || 'Rapid swap provider rate limit'
          })
        }).catch(() => {});

        const payload = {
          finished_at: rateLimitedAt,
          status: 'success',
          error: error.message || 'Rapid swap provider rate limit',
          stats_json: {
            skipped: true,
            skip_reason: 'rate_limited',
            rate_limited_until: rateLimitedUntil,
            cooldown_seconds: Math.round(cooldownMs / 1000)
          }
        };

        if (jobId) {
          await completeJobRun(client, jobId, payload).catch(() => {});
        }

        return {
          ok: true,
          stats: payload.stats_json
        };
      }

      if (jobId) {
        await completeJobRun(client, jobId, {
          finished_at: new Date().toISOString(),
          status: 'error',
          error: error.message || 'Failed to record rapid swaps'
        }).catch(() => {});
      }

      throw error;
    }
  });
}
