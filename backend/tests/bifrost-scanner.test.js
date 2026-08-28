import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchBifrostScannerInfo,
  normalizeBifrostScannerInfo
} from '../src/shared/bifrost-scanner.js';

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
      }
    },
    async text() { return JSON.stringify(payload); }
  };
}

test('Bifrost scanner provider compacts nodesInfo to scanner aggregation fields', async () => {
  const raw = [{
    node_address: 'thor1active',
    status: 'Active',
    ip_address: '192.0.2.1',
    total_bond: '999999999',
    location: { country: 'Example' },
    observe_chains: [{ chain: 'SOL', height: 1 }],
    scanner: {
      SOL: {
        chain: 'SOL',
        chain_height: 400_000_000,
        block_scanner_height: 399_999_998,
        scanner_height_diff: 2,
        healthy: true,
        extra: 'discard me'
      },
      THOR: {
        chain: 'THOR',
        chain_height: 20,
        block_scanner_height: -1,
        scanner_height_diff: -1
      }
    }
  }];
  const calls = [];
  const compact = await fetchBifrostScannerInfo({
    url: 'https://scanner.example/custom/nodes?network=mainnet',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(raw);
    }
  });

  assert.equal(calls[0].url, 'https://scanner.example/custom/nodes?network=mainnet');
  assert.deepEqual(compact, [{
    node_address: 'thor1active',
    scanner: {
      SOL: {
        chain_height: 400_000_000,
        block_scanner_height: 399_999_998,
        scanner_height_diff: 2,
        healthy: true
      }
    }
  }]);
  assert.equal(JSON.stringify(compact).includes('ip_address'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 250);
});

test('Bifrost scanner provider rejects payloads without usable non-negative diffs', async () => {
  assert.throws(() => normalizeBifrostScannerInfo([{
    node_address: 'thor1node',
    scanner: {
      SOL: { chain_height: 10, scanner_height_diff: -1 },
      BTC: { chain_height: 10 }
    }
  }]), /no usable scanner-height records/);

  await assert.rejects(() => fetchBifrostScannerInfo({
    url: 'https://scanner.example/api/nodesInfo',
    fetchImpl: async () => jsonResponse({ error: 'not an array' })
  }), /expected a non-empty node array/);
});

test('Bifrost scanner provider enforces its request timeout', async () => {
  await assert.rejects(() => fetchBifrostScannerInfo({
    url: 'https://scanner.example/api/nodesInfo',
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  }), /aborted/);
});
