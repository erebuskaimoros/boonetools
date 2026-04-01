import { withAdvisoryLock } from '../db/lock.js';
import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import {
  buildRapidSwapCanonicalScanPlan,
  fetchRapidSwapPriceIndex,
  fetchRapidSwapRows,
  mergeRapidSwapRowsByTxId,
  resolveRapidSwapHint,
  summarizeRapidSwapCanonicalScan
} from '../shared/rapid-swaps.js';
import { upsertRapidSwaps } from '../db/rapid-swaps-store.js';

const SYNC_KEY = 'rapid-swaps-canonical';

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

async function resolvePendingCandidates(client, priceIndex) {
  const now = new Date().toISOString();
  const { rows: candidates } = await client.query(
    `select *
     from rapid_swap_candidates
     where status = $1
       and next_retry_at <= $2
     order by first_seen_at asc
     limit $3`,
    [
      'pending',
      now,
      Math.max(1, config.rapidSwapsPendingCandidateBatch)
    ]
  );

  const updates = [];
  const upsertRowsForRapidSwaps = [];
  let resolved = 0;
  let errored = 0;
  let deferred = 0;

  for (const candidate of candidates || []) {
    const attempts = Number(candidate.attempts || 0) + 1;
    const result = await resolveRapidSwapHint(candidate, {
      priceIndex
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

    try {
      jobId = await insertJobRun(client, {
        job_name: 'rapid-swaps-recent-actions',
        status: 'running'
      });

      const [syncState, priceIndex] = await Promise.all([
        loadSyncState(client),
        fetchRapidSwapPriceIndex()
      ]);

      const { rows: recentRows } = await client.query(
        `select tx_id
         from rapid_swaps
         order by action_date desc
         limit 2000`
      );
      const knownTxIds = new Set((recentRows || []).map((row) => String(row.tx_id || '')));

      const pendingResolution = await resolvePendingCandidates(client, priceIndex);
      const scanPlan = buildRapidSwapCanonicalScanPlan({
        syncState,
        overlapBlocks: config.rapidSwapsHeightOverlapBlocks,
        headMaxPages: config.rapidSwapsMaxPages,
        catchupMaxPages: config.rapidSwapsCatchupMaxPages
      });

      const headScan = await fetchRapidSwapRows({
        maxPages: scanPlan.head.maxPages,
        knownTxIds,
        stopBelowHeight: scanPlan.head.stopBelowHeight,
        priceIndex
      });

      const catchupScan = scanPlan.catchup && !headScan.reachedStopHeight
        ? await fetchRapidSwapRows({
            maxPages: scanPlan.catchup.maxPages,
            nextPageToken: scanPlan.catchup.nextPageToken,
            stopBelowHeight: scanPlan.catchup.stopBelowHeight,
            priceIndex
          })
        : null;

      const rowsToUpsert = mergeRapidSwapRowsByTxId(
        pendingResolution.upsertRows,
        headScan.rows,
        catchupScan?.rows || []
      );
      await upsertRapidSwaps(client, rowsToUpsert);

      const scanSummary = summarizeRapidSwapCanonicalScan({
        syncState,
        plan: scanPlan,
        headScan,
        catchupScan
      });

      await saveSyncState(client, {
        last_scanned_height: Number(scanSummary.lastScannedHeight || 0),
        last_scanned_at: new Date().toISOString(),
        stats_json: scanSummary.stats
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
          pending_candidates_loaded: pendingResolution.pendingLoaded,
          candidates_resolved: pendingResolution.resolved,
          candidates_deferred: pendingResolution.deferred,
          candidates_errored: pendingResolution.errored,
          pending_candidates_remaining: pendingCount,
          scan_stop_below_height: scanPlan.head.stopBelowHeight,
          scan_reached_floor: Boolean(headScan.reachedStopHeight),
          scan_lagging: Boolean(scanSummary.lagging),
          highest_height_seen: headScan.highestHeight,
          lowest_height_seen: headScan.lowestHeight,
          next_page_token: scanSummary.stats.next_page_token || '',
          scanned_pages: Number(headScan.scannedPages || 0) + Number(catchupScan?.scannedPages || 0),
          scanned_actions: Number(headScan.scannedActions || 0) + Number(catchupScan?.scannedActions || 0),
          catchup_scanned_pages: Number(catchupScan?.scannedPages || 0),
          catchup_scanned_actions: Number(catchupScan?.scannedActions || 0),
          rapid_swaps_upserted: rowsToUpsert.length,
          observed_at: headScan.observedAt,
          stopped_early: Boolean(headScan.stoppedEarly),
          catchup_active: Boolean(scanPlan.catchup),
          catchup_reached_floor: Boolean(catchupScan?.reachedStopHeight)
        }
      };

      await completeJobRun(client, jobId, payload);

      return {
        ok: true,
        stats: payload.stats_json
      };
    } catch (error) {
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
