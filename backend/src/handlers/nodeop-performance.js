import { query } from '../db/pool.js';
import { error, isValidThorAddress, json } from '../lib/http.js';
import { toIsoString } from '../lib/utils.js';

function normalizeChainSyncRows(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter((row) => typeof row === 'object' && row !== null)
    .map((row) => ({
      chain: String(row.chain || ''),
      node_height: Number(row.node_height) || 0,
      network_max: Number(row.network_max) || 0,
      lag: Number(row.lag) || 0
    }));
}

export async function handleNodeopPerformance(_request, url) {
  const nodeAddress = (url.searchParams.get('node_address') || '').trim();

  if (!isValidThorAddress(nodeAddress)) {
    return error('Invalid node_address query param', 400);
  }

  const { rows } = await query(
    `select
       as_of,
       node_address,
       source_height,
       status,
       slash_points,
       missing_blocks,
       current_award_base,
       jail_jailed,
       jail_release_height,
       jail_blocks_remaining,
       jail_reason,
       node_version,
       majority_version,
       version_compliant,
       preflight_status,
       preflight_reason,
       preflight_code,
       chain_sync_json
     from nodeop_performance_samples
     where node_address = $1
     order by sample_hour desc
     limit 1`,
    [nodeAddress]
  );

  if (rows.length === 0) {
    return error('No performance sample found for this node yet', 404);
  }

  const row = rows[0];
  return json(
    {
      as_of: toIsoString(row.as_of),
      node_address: row.node_address,
      source_height: Number(row.source_height) || 0,
      status: row.status || '',
      slash_points: Number(row.slash_points) || 0,
      missing_blocks: Number(row.missing_blocks) || 0,
      current_award_rune: (Number(row.current_award_base) || 0) / 1e8,
      jail: {
        jailed: Boolean(row.jail_jailed),
        release_height: Number(row.jail_release_height) || 0,
        blocks_remaining: Number(row.jail_blocks_remaining) || 0,
        reason: row.jail_reason || ''
      },
      version: {
        node: row.node_version || '',
        majority: row.majority_version || '',
        compliant: typeof row.version_compliant === 'boolean' ? row.version_compliant : null
      },
      preflight: {
        status: row.preflight_status || '',
        reason: row.preflight_reason || '',
        code: Number(row.preflight_code) || 0
      },
      chain_sync: normalizeChainSyncRows(row.chain_sync_json)
    },
    200,
    {
      'Cache-Control': 'public, max-age=6'
    }
  );
}
