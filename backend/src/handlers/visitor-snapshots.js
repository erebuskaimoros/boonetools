import { error, json } from '../lib/http.js';
import { readVisitorSnapshot, visitorSnapshotKey } from '../shared/visitor-snapshots.js';

async function response(kind, params) {
  try { visitorSnapshotKey(kind, params); }
  catch (invalid) { return error(invalid.message, 400); }
  const { getClient } = await import('../db/pool.js');
  const client = await getClient();
  try {
    const snapshot = await readVisitorSnapshot(client, kind, params);
    if (!snapshot) return error('Shared data is warming up. Retrying shortly.', 503, { 'Retry-After': '5', 'Cache-Control': 'no-store' });
    return json(snapshot, 200, { 'Cache-Control': snapshot.stale ? 'public, max-age=5' : 'public, max-age=15' });
  } finally { client.release(); }
}

export const handleDynamicFeeSnapshot = () => response('dynamic-fees', {});
export const handleVaultExplorerSnapshot = () => response('vault', {});
export const handleDynamicFeeHistory = (_request, url) => response('affiliate-history', { affiliate: url.searchParams.get('affiliate') || '' });
