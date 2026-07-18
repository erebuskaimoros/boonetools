import assert from 'node:assert/strict';
import test from 'node:test';

import { MIDGARD_ENDPOINTS, fetchMidgardJSON } from '../src/lib/utils/api.js';

function createJsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    }
  };
}

test('fetchMidgardJSON stops on a primary rate limit without probing fallback', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);
    return createJsonResponse({ error: 'rate limited' }, 429);
  };

  try {
    await assert.rejects(
      () => fetchMidgardJSON('/v2/pools'),
      /rate limited|429/i
    );
    assert.deepEqual(calls, [`${MIDGARD_ENDPOINTS.primary}/v2/pools`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
