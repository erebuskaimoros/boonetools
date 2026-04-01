import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { getClient, closePool } from './db/pool.js';
import { upsertRows } from './db/sql.js';

const pageSize = Number(process.env.BOONETOOLS_IMPORT_PAGE_SIZE || 1000);
const replaceAll = ['1', 'true', 'yes'].includes(String(process.env.BOONETOOLS_IMPORT_REPLACE || '').toLowerCase());

const supabaseProjectRef = process.env.SUPABASE_PROJECT_REF || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseProjectRef || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_PROJECT_REF and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabaseBaseUrl = `https://${supabaseProjectRef}.supabase.co/rest/v1`;

const tables = [
  { name: 'nodeop_job_runs', conflictColumns: ['id'], jsonColumns: ['stats_json'] },
  { name: 'nodeop_performance_samples', conflictColumns: ['sample_hour', 'node_address'], jsonColumns: ['chain_sync_json'] },
  { name: 'nodeop_churn_events', conflictColumns: ['height'] },
  { name: 'nodeop_boundary_snapshots', conflictColumns: ['height', 'node_address'] },
  { name: 'nodeop_leaderboard_latest', conflictColumns: ['node_address'] },
  { name: 'rapid_swap_job_runs', conflictColumns: ['id'], jsonColumns: ['stats_json'] },
  { name: 'rapid_swaps', conflictColumns: ['tx_id'] },
  { name: 'rapid_swap_candidates', conflictColumns: ['hint_key'], jsonColumns: ['raw_hint'] },
  { name: 'rapid_swap_sync_state', conflictColumns: ['sync_key'], jsonColumns: ['stats_json'] },
  { name: 'bond_history', conflictColumns: ['bond_address', 'churn_height'], jsonColumns: ['rates_json'] }
];

async function fetchSupabasePage(tableName, offset) {
  const url = `${supabaseBaseUrl}/${tableName}?select=*&limit=${pageSize}&offset=${offset}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${tableName} (${response.status})`);
  }

  return response.json();
}

async function maybeReplaceLocalData(client) {
  if (!replaceAll) {
    return;
  }

  await client.query(`
    truncate table
      nodeop_leaderboard_latest,
      nodeop_boundary_snapshots,
      nodeop_churn_events,
      nodeop_performance_samples,
      nodeop_job_runs,
      rapid_swap_candidates,
      rapid_swap_sync_state,
      rapid_swaps,
      rapid_swap_job_runs,
      bond_history
    restart identity cascade
  `);
}

const client = await getClient();

try {
  await maybeReplaceLocalData(client);

  for (const table of tables) {
    let offset = 0;
    let imported = 0;

    while (true) {
      const rows = await fetchSupabasePage(table.name, offset);
      if (!Array.isArray(rows) || rows.length === 0) {
        break;
      }

      await upsertRows(client, table.name, rows, {
        conflictColumns: table.conflictColumns,
        jsonColumns: table.jsonColumns
      });

      imported += rows.length;
      offset += rows.length;
      console.log(`${table.name}: imported ${imported}`);

      if (rows.length < pageSize) {
        break;
      }
    }
  }
} finally {
  client.release();
  await closePool().catch(() => {});
}
