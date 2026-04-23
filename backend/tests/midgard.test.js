import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIDGARD_BASES,
  fetchMidgardActions,
  fetchMidgardBond,
  fetchMidgardChurns
} from '../src/shared/midgard.js';

function createResponse({
  body,
  status = 200,
  statusText = 'OK',
  headers = { 'content-type': 'application/json' }
}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        return headers[String(name || '').toLowerCase()] || null;
      }
    },
    async text() {
      return body;
    }
  };
}

test('fetchMidgardBond falls back when the primary bond endpoint fails', async () => {
  const originalFetch = globalThis.fetch;
  const [primary, fallback] = MIDGARD_BASES;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${primary}/bonds/thor1test`) {
      return createResponse({
        body: JSON.stringify({ error: 'upstream failure' }),
        status: 500,
        statusText: 'Internal Server Error'
      });
    }

    if (url === `${fallback}/bonds/thor1test`) {
      return createResponse({
        body: JSON.stringify({
          nodes: [{ address: 'thor1node', bond: '250000000' }]
        })
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const payload = await fetchMidgardBond('thor1test');
    assert.equal(payload.nodes[0].address, 'thor1node');
    assert.deepEqual(calls, [
      `${primary}/bonds/thor1test`,
      `${fallback}/bonds/thor1test`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchMidgardActions falls back when the primary returns invalid JSON', async () => {
  const originalFetch = globalThis.fetch;
  const [primary, fallback] = MIDGARD_BASES;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${primary}/actions?address=thor1test&type=bond&limit=50&offset=0`) {
      return createResponse({
        body: '{"actions":',
        status: 200
      });
    }

    if (url === `${fallback}/actions?address=thor1test&type=bond&limit=50&offset=0`) {
      return createResponse({
        body: JSON.stringify({
          actions: [{ height: '123', metadata: { bond: { nodeAddress: 'thor1node' } } }]
        })
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const payload = await fetchMidgardActions({
      address: 'thor1test',
      type: 'bond',
      limit: 50,
      offset: 0
    });

    assert.equal(payload.actions.length, 1);
    assert.deepEqual(calls, [
      `${primary}/actions?address=thor1test&type=bond&limit=50&offset=0`,
      `${fallback}/actions?address=thor1test&type=bond&limit=50&offset=0`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchMidgardActions stops when the primary is rate-limited', async () => {
  const originalFetch = globalThis.fetch;
  const [primary] = MIDGARD_BASES;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${primary}/actions?address=thor1test&type=bond&limit=50&offset=0`) {
      return createResponse({
        body: 'Slow down you have hit your daily request limit',
        status: 429,
        statusText: 'Too Many Requests'
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await assert.rejects(
      () => fetchMidgardActions({
        address: 'thor1test',
        type: 'bond',
        limit: 50,
        offset: 0
      }),
      /429|Too Many Requests/
    );
    assert.deepEqual(calls, [
      `${primary}/actions?address=thor1test&type=bond&limit=50&offset=0`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchMidgardChurns falls back when the primary returns malformed JSON', async () => {
  const originalFetch = globalThis.fetch;
  const [primary, fallback] = MIDGARD_BASES;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${primary}/churns`) {
      return createResponse({
        body: '',
        status: 200
      });
    }

    if (url === `${fallback}/churns`) {
      return createResponse({
        body: JSON.stringify([{ height: '123', date: '123000000000' }])
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const payload = await fetchMidgardChurns();
    assert.equal(payload.length, 1);
    assert.deepEqual(calls, [
      `${primary}/churns`,
      `${fallback}/churns`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
