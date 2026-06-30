import { json } from '../lib/http.js';
import { getRujiraReservePaymentsDashboardPayload } from '../shared/rujira-reserve-payments.js';

export async function handleAppLayerReservePayments() {
  const payload = await getRujiraReservePaymentsDashboardPayload();
  return json(payload, 200, {
    'Cache-Control': 'public, max-age=60'
  });
}
