import { json } from '../lib/http.js';
import { getNetworkSnapshot } from '../shared/network-snapshot.js';

const ALLOWED_FIELDS = new Set([
  'inbound_addresses', 'nodes', 'mimir', 'lastblock', 'network',
  'pools', 'constants', 'node_mimirs', 'churns', 'version'
]);

// signer_membership is ~68% of the node list and no browser view reads it.
// `fields=` narrows each node further for views that need only a few values.
export function browserNodes(nodes, fields = []) {
  return (Array.isArray(nodes) ? nodes : []).map(({ signer_membership: _unused, ...node }) => (
    fields.length ? Object.fromEntries(fields.filter((key) => key in node).map((key) => [key, node[key]])) : node
  ));
}

export async function handleNetworkSnapshot(_request, url) {
  const payload = await getNetworkSnapshot();
  const requestedField = String(url?.searchParams?.get('field') || '').trim();
  const fields = String(url?.searchParams?.get('fields') || '').split(',')
    .map((key) => key.trim()).filter((key) => /^[a-z_]{1,40}$/.test(key));
  const nodes = browserNodes(payload.nodes, requestedField === 'nodes' ? fields : []);
  const body = ALLOWED_FIELDS.has(requestedField)
    ? requestedField === 'nodes' ? nodes : payload[requestedField]
    : { ...payload, nodes };
  const withMeta = ALLOWED_FIELDS.has(requestedField) && url?.searchParams?.get('include_meta') === 'true';
  return json(withMeta ? { value: body, field_meta: payload.field_meta?.[requestedField] || {}, stale: payload.stale } : body, 200, {
    'Cache-Control': payload.stale
      ? 'public, max-age=5, stale-if-error=60'
      : 'public, max-age=10, stale-while-revalidate=15'
  });
}
