import { json } from '../lib/http.js';
import { getNetworkSnapshot } from '../shared/network-snapshot.js';

export async function handleNetworkSnapshot(_request, url) {
  const payload = await getNetworkSnapshot();
  const requestedField = String(url?.searchParams?.get('field') || '').trim();
  const allowedFields = new Set([
    'inbound_addresses', 'nodes', 'mimir', 'lastblock', 'network',
    'pools', 'constants', 'node_mimirs', 'churns'
  ]);
  const body = allowedFields.has(requestedField) ? payload[requestedField] : payload;
  return json(body, 200, {
    'Cache-Control': payload.stale
      ? 'public, max-age=5, stale-if-error=60'
      : 'public, max-age=10, stale-while-revalidate=15'
  });
}
