import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIDGARD_BASE,
  MIDGARD_FALLBACK_BASE,
  MidgardClient
} from '../src/lib/api/midgard.js';

function createJsonResponse(data, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      return data;
    }
  };
}

test('getActions falls back when the primary origin is rate-limited', async () => {
  const client = new MidgardClient();
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${MIDGARD_BASE}/actions?address=thor1bond&type=bond&limit=50&offset=0`) {
      return createJsonResponse({ error: 'rate limited' }, 429, 'Too Many Requests');
    }

    if (url === `${MIDGARD_FALLBACK_BASE}/actions?address=thor1bond&type=bond&limit=50&offset=0`) {
      return createJsonResponse({
        actions: [{ height: '123', in: [{ txID: 'ABC' }] }],
        meta: {}
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const data = await client.getActions({
      address: 'thor1bond',
      type: 'bond',
      limit: 50,
      offset: 0
    }, { cache: false });

    assert.equal(data.actions.length, 1);
    assert.deepEqual(calls, [
      `${MIDGARD_BASE}/actions?address=thor1bond&type=bond&limit=50&offset=0`,
      `${MIDGARD_FALLBACK_BASE}/actions?address=thor1bond&type=bond&limit=50&offset=0`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
