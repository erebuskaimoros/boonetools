import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchRapidSwapRows } from '../_shared/rapid-swaps.ts';
import {
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  parseAuthToken,
  requireMethod
} from '../_shared/validation.ts';

type SupabaseAdmin = ReturnType<typeof createClient>;

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
    const maxPages = Math.max(1, Number(Deno.env.get('RAPID_SWAPS_MAX_PAGES') || 20));

    jobId = await insertJobRun(supabase, {
      job_name: 'rapid-swaps-recent-actions',
      status: 'running'
    });

    const result = await fetchRapidSwapRows({ maxPages });
    await upsertRapidSwaps(supabase, result.rows);

    const payload = {
      job_name: 'rapid-swaps-recent-actions',
      finished_at: new Date().toISOString(),
      status: 'success',
      stats_json: {
        scanned_pages: result.scannedPages,
        scanned_actions: result.scannedActions,
        rapid_swaps_upserted: result.rows.length,
        observed_at: result.observedAt
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
