import { query } from './pool.js';
import { upsertRows } from './sql.js';
import {
  choosePreferredSource,
  EVENT_SOURCE_PRIORITY,
  enrichEventRows,
  recordEventSourceObservations,
  selectPreferredEventRows,
  withEventTransaction
} from '../lib/provenance.js';
import {
  normalizeRapidSwapHint,
  RAPID_SWAP_CANDIDATE_STATUS
} from '../shared/rapid-swaps.js';

function rapidSwapSource(row) {
  return choosePreferredSource('', row?.raw_action?.source || row?.source || 'midgard');
}

async function upsertCanonicalRapidSwaps(client, rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  await upsertRows(client, 'rapid_swaps', rows, {
    columns,
    conflictColumns: ['canonical_key'],
    updateColumns: columns.filter((column) => !['canonical_key', 'tx_id'].includes(column)),
    updateStrategies: {
      first_seen_at: 'least',
      last_seen_at: 'greatest',
      schema_version: 'greatest'
    },
    sourcePreference: {
      column: 'preferred_source',
      priorities: EVENT_SOURCE_PRIORITY,
      observedAtColumn: 'last_seen_at'
    },
    jsonColumns: ['raw_action']
  });
}

async function persistRapidSwaps(client, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const enriched = await enrichEventRows(client, {
    table: 'rapid_swaps',
    rows,
    canonicalKey: (row) => String(row.tx_id || '').trim().toUpperCase(),
    source: rapidSwapSource,
    observedAt: (row) => row.observed_at
  });
  const canonicalRows = selectPreferredEventRows(enriched);

  await withEventTransaction(client, async () => {
    await upsertCanonicalRapidSwaps(client, canonicalRows);
    await recordEventSourceObservations(client, {
      domain: 'rapid-swaps',
      rows: enriched,
      source: rapidSwapSource,
      sourceEventKey: (row) => row.tx_id,
      rawReference: (row) => ({
        tx_id: row.tx_id,
        action_height: row.action_height || 0
      })
    });
  });

  return enriched.length;
}

async function readExistingCandidate(client, hintKey) {
  const { rows } = await client.query(
    `select status, attempts, resolved_tx_id, resolved_at
     from rapid_swap_candidates
     where hint_key = $1
     limit 1`,
    [hintKey]
  );

  return rows[0] || null;
}

export async function upsertRapidSwap(client, row) {
  await persistRapidSwaps(client, [row]);
}

export async function upsertRapidSwaps(client, rows) {
  await persistRapidSwaps(client, rows);
}

export async function upsertRapidSwapCandidate(client, hintInput, patch = {}) {
  const now = new Date().toISOString();
  const candidate = normalizeRapidSwapHint({
    ...hintInput,
    ...patch
  });
  const existing = await readExistingCandidate(client, candidate.hint_key);

  const preserveResolved = existing?.status === RAPID_SWAP_CANDIDATE_STATUS.RESOLVED
    && candidate.status !== RAPID_SWAP_CANDIDATE_STATUS.RESOLVED;

  await upsertRows(client, 'rapid_swap_candidates', [
    {
      hint_key: candidate.hint_key,
      source: candidate.source,
      tx_id: candidate.tx_id,
      source_address: candidate.source_address,
      memo: candidate.memo,
      observed_height: candidate.observed_height,
      last_height: candidate.last_height,
      status: preserveResolved ? existing.status : candidate.status,
      attempts: preserveResolved
        ? Number(existing.attempts || candidate.attempts || 0)
        : candidate.attempts,
      last_seen_at: now,
      next_retry_at: patch.next_retry_at || now,
      resolved_tx_id: patch.resolved_tx_id || existing?.resolved_tx_id || '',
      resolved_at: patch.resolved_at || existing?.resolved_at || null,
      last_error: preserveResolved ? null : (patch.last_error || null),
      raw_hint: candidate.raw_hint
    }
  ], {
    conflictColumns: ['hint_key'],
    jsonColumns: ['raw_hint']
  });
}

export async function writeRapidSwapListenerHeartbeat(stats) {
  await query('delete from rapid_swap_job_runs where job_name = $1', ['rapid-swaps-ws-listener']);
  await query(
    `insert into rapid_swap_job_runs
      (job_name, started_at, finished_at, status, stats_json)
     values ($1, $2, $3, $4, $5)`,
    [
      'rapid-swaps-ws-listener',
      stats.started_at,
      stats.finished_at,
      stats.status,
      stats.stats_json
    ]
  );
}
