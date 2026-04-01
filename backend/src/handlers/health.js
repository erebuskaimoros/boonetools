import { json } from '../lib/http.js';

export async function handleHealth() {
  return json({
    ok: true,
    service: 'boonetools-backend',
    as_of: new Date().toISOString()
  });
}
