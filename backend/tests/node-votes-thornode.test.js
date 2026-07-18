import assert from 'node:assert/strict';
import test from 'node:test';

function createJsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
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

test('node-vote historical metadata uses the canonical THORNode archive fallback', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  process.env.NODE_VOTES_REQUEST_DELAY_MS = '0';

  const [nodeVotes, thornode] = await Promise.all([
    import('../src/shared/node-votes.js'),
    import('../src/shared/thornode.js')
  ]);
  const originalFetch = globalThis.fetch;
  const calls = [];
  const nodeAddress = 'thor1historicalnodexxxxxxxxxxxxxxxxxxxxxx';

  globalThis.fetch = async (url) => {
    calls.push(url);

    if (url === `${thornode.THORNODE_PRIMARY}/thorchain/nodes`) {
      return createJsonResponse([]);
    }

    if (url === `${thornode.THORNODE_PRIMARY}/thorchain/node/${nodeAddress}?height=123`) {
      return createJsonResponse({ error: 'historical state unavailable' }, 404);
    }

    if (url === `${thornode.THORNODE_ARCHIVE}/thorchain/node/${nodeAddress}?height=123`) {
      return createJsonResponse({
        node_address: nodeAddress,
        node_operator_address: 'thor1historicaloperatorxxxxxxxxxxxxxxxxx',
        status: 'Standby'
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const [row] = await nodeVotes.enrichRowsWithNodeMetadata([{
      node_address: nodeAddress,
      node_operator_address: '',
      node_status: '',
      height: 123
    }]);

    assert.equal(row.node_operator_address, 'thor1historicaloperatorxxxxxxxxxxxxxxxxx');
    assert.equal(row.node_status, 'Standby');
    assert.deepEqual(calls, [
      `${thornode.THORNODE_PRIMARY}/thorchain/nodes`,
      `${thornode.THORNODE_PRIMARY}/thorchain/node/${nodeAddress}?height=123`,
      `${thornode.THORNODE_ARCHIVE}/thorchain/node/${nodeAddress}?height=123`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
