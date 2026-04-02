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

test('getSwapHistory falls back when the primary origin returns empty interval buckets', async () => {
  const client = new MidgardClient();
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${MIDGARD_BASE}/history/swaps?interval=hour&count=24`) {
      return createJsonResponse({
        intervals: [],
        meta: {
          startTime: '1',
          endTime: '2'
        }
      });
    }

    if (url === `${MIDGARD_FALLBACK_BASE}/history/swaps?interval=hour&count=24`) {
      return createJsonResponse({
        intervals: [
          {
            startTime: '1',
            endTime: '2',
            totalVolumeUSD: '100',
            totalCount: '5'
          }
        ],
        meta: {
          startTime: '1',
          endTime: '2'
        }
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const data = await client.getSwapHistory({ interval: 'hour', count: 24 }, { cache: false });
    assert.equal(data.intervals.length, 1);
    assert.deepEqual(calls, [
      `${MIDGARD_BASE}/history/swaps?interval=hour&count=24`,
      `${MIDGARD_FALLBACK_BASE}/history/swaps?interval=hour&count=24`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getActions falls back when the primary origin ignores a small limit', async () => {
  const client = new MidgardClient();
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${MIDGARD_BASE}/actions?type=swap&limit=3`) {
      return createJsonResponse({
        actions: new Array(50).fill(null).map((_, index) => ({ id: index + 1 })),
        count: '50',
        meta: {}
      });
    }

    if (url === `${MIDGARD_FALLBACK_BASE}/actions?type=swap&limit=3`) {
      return createJsonResponse({
        actions: [{ id: 1 }, { id: 2 }, { id: 3 }],
        count: '3',
        meta: {}
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const data = await client.getActions({ type: 'swap', limit: 3 }, { cache: false });
    assert.equal(data.actions.length, 3);
    assert.deepEqual(calls, [
      `${MIDGARD_BASE}/actions?type=swap&limit=3`,
      `${MIDGARD_FALLBACK_BASE}/actions?type=swap&limit=3`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
