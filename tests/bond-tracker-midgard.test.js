import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIDGARD_BASE,
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

test('getActions stops when the primary origin is rate-limited', async () => {
  const client = new MidgardClient();
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${MIDGARD_BASE}/actions?address=thor1bond&type=bond&limit=50&offset=0`) {
      return createJsonResponse({ error: 'rate limited' }, 429, 'Too Many Requests');
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await assert.rejects(
      () => client.getActions({
        address: 'thor1bond',
        type: 'bond',
        limit: 50,
        offset: 0
      }, { cache: false }),
      /429|Too Many Requests/
    );
    assert.deepEqual(calls, [
      `${MIDGARD_BASE}/actions?address=thor1bond&type=bond&limit=50&offset=0`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
