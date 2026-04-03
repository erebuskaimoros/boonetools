import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THORNODE_ARCHIVE,
  THORNODE_FALLBACK,
  THORNODE_PRIMARY,
  fetchThorchain
} from '../src/shared/thornode.js';

function createJsonResponse(data, status = 200, statusText = 'OK', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        return headers[String(name || '').toLowerCase()] || null;
      }
    },
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    }
  };
}

test('fetchThorchain falls back to the archive endpoint on historical requests when the primary is rate-limited', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${THORNODE_PRIMARY}/thorchain/network?height=25573978`) {
      return createJsonResponse({ error: 'rate limited' }, 429, 'Too Many Requests');
    }

    if (url === `${THORNODE_ARCHIVE}/thorchain/network?height=25573978`) {
      return createJsonResponse({ rune_price_in_tor: '41152196' });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const payload = await fetchThorchain('/thorchain/network?height=25573978', {
      historical: true
    });

    assert.equal(payload.rune_price_in_tor, '41152196');
    assert.deepEqual(calls, [
      `${THORNODE_PRIMARY}/thorchain/network?height=25573978`,
      `${THORNODE_ARCHIVE}/thorchain/network?height=25573978`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
