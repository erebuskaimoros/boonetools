import { json } from '../lib/http.js';
import { getStuckTransactionSnapshot } from '../shared/stuck-transactions.js';

export async function handleStuckTransactions() {
  const payload = await getStuckTransactionSnapshot();
  return json(payload, 200, {
    'Cache-Control': payload.stale ? 'public, max-age=15' : 'public, max-age=30'
  });
}
