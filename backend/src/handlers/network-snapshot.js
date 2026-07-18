import { json } from '../lib/http.js';
import { getNetworkSnapshot } from '../shared/network-snapshot.js';

export async function handleNetworkSnapshot(_request, url) {
  const payload = await getNetworkSnapshot({
    forceRefresh: url?.searchParams?.get('refresh') === '1'
  });
  return json(payload, 200, {
    'Cache-Control': payload.stale
      ? 'public, max-age=5, stale-if-error=60'
      : 'public, max-age=10, stale-while-revalidate=15'
  });
}
