import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  buildRapidSwapCanonicalScanPlan,
  fetchRapidSwapPriceIndex,
  fetchRapidSwapRows,
  mergeRapidSwapRowsByTxId,
  summarizeRapidSwapCanonicalScan,
  resolveRapidSwapHint
} from '../_shared/rapid-swaps.ts';
import {
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  parseAuthToken,
  requireMethod
} from '../_shared/validation.ts';

type SupabaseAdmin = ReturnType<typeof createClient>;
type SyncStateRow = {
  sync_key: string;
  last_scanned_height: number;
  last_scanned_at: string | null;
  stats_json: Record<string, unknown> | null;
};

const SYNC_KEY = 'rapid-swaps-canonical';

function createAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function chunkArray<T>(items: T[], chunkSize = 250): T[][] {
  if (items.length <= chunkSize) {
    return [items];
  }

  const output: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    output.push(items.slice(i, i + chunkSize));
  }
  return output;
}

function assertSchedulerAuth(request: Request): void {
  const token = parseAuthToken(request);
  if (!token) {
    throw new Error('Forbidden');
  }

  const tokenParts = token.split('.');
  if (tokenParts.length < 2) {
    throw new Error('Forbidden');
  }

  let role = '';
  try {
    const payloadJson = atob(tokenParts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson);
    role = String(payload?.role || '');
  } catch (_) {
    throw new Error('Forbidden');
  }

  if (role !== 'service_role') {
    throw new Error('Forbidden');
  }

  const expectedSecret = Deno.env.get('NODEOP_SCHEDULER_SECRET') || '';
  if (expectedSecret) {
    const providedSecret = request.headers.get('x-nodeop-secret') || '';
    if (providedSecret !== expectedSecret) {
      throw new Error('Forbidden');
    }
  }
}

function computeRetryDelaySeconds(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(30 * 60, 60 * Math.pow(2, Math.min(normalizedAttempt - 1, 5)));
}

async function insertJobRun(supabase: SupabaseAdmin, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase
    .from('rapid_swap_job_runs')
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to insert rapid_swap_job_runs row: ${error.message}`);
  }

  return String(data.id);
}

async function completeJobRun(
  supabase: SupabaseAdmin,
  jobId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from('rapid_swap_job_runs')
    .update(payload)
    .eq('id', jobId);

  if (error) {
    throw new Error(`Failed to update rapid_swap_job_runs row: ${error.message}`);
  }
}

async function upsertRapidSwaps(supabase: SupabaseAdmin, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  for (const chunk of chunkArray(rows, 200)) {
    const { error } = await supabase
      .from('rapid_swaps')
      .upsert(chunk, { onConflict: 'tx_id' });

    if (error) {
      throw new Error(`Failed to upsert rapid swaps: ${error.message}`);
    }
  }
}

async function loadSyncState(supabase: SupabaseAdmin): Promise<SyncStateRow | null> {
  const { data, error } = await supabase
    .from('rapid_swap_sync_state')
    .select('sync_key,last_scanned_height,last_scanned_at,stats_json')
    .eq('sync_key', SYNC_KEY)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load rapid_swap_sync_state row: ${error.message}`);
  }

  return data
    ? {
        sync_key: String(data.sync_key),
        last_scanned_height: Number(data.last_scanned_height || 0),
        last_scanned_at: data.last_scanned_at || null,
        stats_json: (data.stats_json as Record<string, unknown>) || {}
      }
    : null;
}

async function saveSyncState(
  supabase: SupabaseAdmin,
  payload: Partial<SyncStateRow> & { stats_json?: Record<string, unknown> }
): Promise<void> {
  const { error } = await supabase
    .from('rapid_swap_sync_state')
    .upsert(
      {
        sync_key: SYNC_KEY,
        last_scanned_height: Number(payload.last_scanned_height || 0),
        last_scanned_at: payload.last_scanned_at || new Date().toISOString(),
        stats_json: payload.stats_json || {}
      },
      { onConflict: 'sync_key' }
    );

  if (error) {
    throw new Error(`Failed to save rapid_swap_sync_state row: ${error.message}`);
  }
}

async function resolvePendingCandidates(
  supabase: SupabaseAdmin,
  priceIndex: Awaited<ReturnType<typeof fetchRapidSwapPriceIndex>>
): Promise<{
  pendingLoaded: number;
  resolved: number;
  errored: number;
  deferred: number;
  upsertRows: Record<string, unknown>[];
}> {
  const now = new Date().toISOString();
  const maxAttempts = Math.max(1, Number(Deno.env.get('RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS') || 12));
  const batchSize = Math.max(1, Number(Deno.env.get('RAPID_SWAPS_PENDING_CANDIDATE_BATCH') || 100));

  const { data: candidates, error } = await supabase
    .from('rapid_swap_candidates')
    .select('*')
    .eq('status', 'pending')
    .lte('next_retry_at', now)
    .order('first_seen_at', { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`Failed to load rapid_swap_candidates rows: ${error.message}`);
  }

  const updates: Record<string, unknown>[] = [];
  const upsertRows: Record<string, unknown>[] = [];
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
      error: resolveError as Error
    }));

    const hint = result.hint || candidate;
    if (result.row) {
      upsertRows.push(result.row);
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

    const shouldError = attempts >= maxAttempts;
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
    const { error: updateError } = await supabase
      .from('rapid_swap_candidates')
      .upsert(updates, { onConflict: 'hint_key' });

    if (updateError) {
      throw new Error(`Failed to update rapid_swap_candidates rows: ${updateError.message}`);
    }
  }

  return {
    pendingLoaded: (candidates || []).length,
    resolved,
    errored,
    deferred,
    upsertRows
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const methodError = requireMethod(request, 'POST');
  if (methodError) {
    return errorResponse(methodError, 405);
  }

  let jobId = '';

  try {
    assertSchedulerAuth(request);

    const supabase = createAdminClient();
    const maxPages = Math.max(1, Number(Deno.env.get('RAPID_SWAPS_MAX_PAGES') || 200));
    const catchupMaxPages = Math.max(1, Number(Deno.env.get('RAPID_SWAPS_CATCHUP_MAX_PAGES') || maxPages));
    const overlapBlocks = Math.max(0, Number(Deno.env.get('RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS') || 1800));

    jobId = await insertJobRun(supabase, {
      job_name: 'rapid-swaps-recent-actions',
      status: 'running'
    });

    const [syncState, priceIndex] = await Promise.all([
      loadSyncState(supabase),
      fetchRapidSwapPriceIndex()
    ]);

    // Fetch recent known tx_ids so we can stop scanning once we overlap
    const knownTxIds = new Set<string>();
    const { data: recentRows } = await supabase
      .from('rapid_swaps')
      .select('tx_id')
      .order('action_date', { ascending: false })
      .limit(2000);

    if (recentRows) {
      for (const row of recentRows) {
        knownTxIds.add(String(row.tx_id));
      }
    }

    const pendingResolution = await resolvePendingCandidates(supabase, priceIndex);
    const scanPlan = buildRapidSwapCanonicalScanPlan({
      syncState,
      overlapBlocks,
      headMaxPages: maxPages,
      catchupMaxPages
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
    await upsertRapidSwaps(supabase, rowsToUpsert);

    const scanSummary = summarizeRapidSwapCanonicalScan({
      syncState,
      plan: scanPlan,
      headScan,
      catchupScan
    });

    await saveSyncState(supabase, {
      last_scanned_height: Number(scanSummary.lastScannedHeight || 0),
      last_scanned_at: new Date().toISOString(),
      stats_json: scanSummary.stats
    });

    const { count: pendingCount, error: pendingCountError } = await supabase
      .from('rapid_swap_candidates')
      .select('hint_key', { count: 'exact', head: true })
      .eq('status', 'pending');

    if (pendingCountError) {
      throw new Error(`Failed to count pending rapid_swap_candidates rows: ${pendingCountError.message}`);
    }

    const payload = {
      job_name: 'rapid-swaps-recent-actions',
      finished_at: new Date().toISOString(),
      status: 'success',
      stats_json: {
        pending_candidates_loaded: pendingResolution.pendingLoaded,
        candidates_resolved: pendingResolution.resolved,
        candidates_deferred: pendingResolution.deferred,
        candidates_errored: pendingResolution.errored,
        pending_candidates_remaining: pendingCount || 0,
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

    await completeJobRun(supabase, jobId, payload);

    return jsonResponse(payload, 200);
  } catch (error) {
    console.error('rapid-swaps-scheduler failed:', error);

    if (jobId) {
      try {
        const supabase = createAdminClient();
        await completeJobRun(supabase, jobId, {
          finished_at: new Date().toISOString(),
          status: 'error',
          error: (error as Error).message || 'Unknown error'
        });
      } catch (updateError) {
        console.error('Failed to write rapid-swap job failure:', updateError);
      }
    }

    const message = (error as Error).message || 'Failed to record rapid swaps';
    const status = message === 'Forbidden' ? 403 : 500;
    return errorResponse(message, status);
  }
});
