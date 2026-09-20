import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNearIssuance } from '../src/protocol-fee-comparison/near.js';
import { requestFromProviders } from '../../shared/provider-client.js';

const unknownBlock = { jsonrpc: '2.0', error: {
  name: 'HANDLER_ERROR', cause: { info: {}, name: 'UNKNOWN_BLOCK' },
  code: -32000, message: 'Server error', data: 'DB Not Found Error: BLOCK HEIGHT: 101'
}, id: 6 };

// Resume one cached epoch, encounter a skipped height in the preceding epoch,
// and verify the next produced block links directly to the known anchor.
function fixture({ httpStatus = 422, errorBody = JSON.stringify(unknownBlock), brokenLink = false } = {}) {
  const timestamp = day => String(BigInt(Date.parse(day)) * 1000000n);
  const cached = { height: 300, timestamp: Date.parse('2026-02-27'), atomic: '3000',
    previousEpochStart: 200, previousEpochHeight: 19, epochHeight: 20 };
  const epochs = { 300: structuredClone(cached) }, calls = [], saved = [];
  const blocks = {
    200: { header: { height: 200, hash: 'epoch-200', prev_height: 199, prev_hash: 'previous-199',
      epoch_id: 'anchor-100', latest_protocol_version: 86, total_supply: '101500',
      timestamp_nanosec: timestamp('2026-02-26') }, chunks: [{ height_included: 200, balance_burnt: '500' }] },
    'previous-199': { header: { height: 199, hash: 'previous-199', epoch_id: 'anchor-50', total_supply: '100000' } },
    'anchor-100': { header: { height: 100, hash: 'anchor-100' } },
    102: { header: { height: 102, hash: 'epoch-102', epoch_id: 'anchor-50',
      prev_hash: brokenLink ? 'not-the-anchor' : 'anchor-100' } }
  };
  const request = (url, { body }) => requestFromProviders({ bases: [url],
    request: { method: 'POST', body: JSON.stringify(body) },
    fetchImpl: async (_url, options) => {
      const { method, params, id } = JSON.parse(options.body);
      calls.push({ method, params });
      if (params.block_id === 101) return new Response(errorBody, {
        status: httpStatus, statusText: 'Archive response', headers: { 'content-type': 'application/json' }
      });
      const result = method === 'validators' ? { epoch_start_height: 300, epoch_height: 20 }
        : params.finality ? { header: { height: 400, timestamp_nanosec: timestamp('2026-02-28') } }
        : blocks[params.block_id];
      assert.ok(result, `Unexpected block ${params.block_id}`);
      return Response.json({ jsonrpc: '2.0', id, result });
    }
  });
  return { epochs, cached, calls, saved, run: () => collectNearIssuance({ request, epochs,
    startDay: '2026-02-27', endDay: '2026-02-28', save: async value => saved.push(structuredClone(value)) }) };
}

test('NEAR archive resumes past HTTP 422 UNKNOWN_BLOCK without losing verified checkpoints', async () => {
  const f = fixture();
  const rows = await f.run();
  assert.deepEqual(f.calls.filter(call => call.method === 'block' && call.params.block_id >= 100)
    .map(call => call.params.block_id), [200, 101, 102]);
  assert.deepEqual(f.epochs[300], f.cached);
  assert.equal(f.epochs[200].previousEpochStart, 102);
  assert.equal(f.epochs[200].atomic, '2000');
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0][200].previousEpochStart, 102);
  assert.equal(rows[0].nearIssuanceAtomic, '3000');
  assert.equal(rows[0].nearIssuanceMethod, 'onchain-epoch-mints-v1');
});

test('NEAR archive still accepts a successful HTTP response containing UNKNOWN_BLOCK', async () => {
  const f = fixture({ httpStatus: 200 });
  await f.run();
  assert.equal(f.epochs[200].previousEpochStart, 102);
});

test('NEAR archive does not treat other provider errors as skipped block heights', async t => {
  for (const [name, httpStatus, errorBody] of [
    ['unrelated 422', 422, JSON.stringify({ error: { cause: { name: 'INVALID_REQUEST' } } })],
    ['rate limit', 429, JSON.stringify(unknownBlock)],
    ['server failure', 503, JSON.stringify(unknownBlock)],
    ['malformed JSON', 422, '{"error":{"cause":{"name":"UNKNOWN_BLOCK"'],
    ['plain text', 422, 'UNKNOWN_BLOCK'],
    ['unrelated error mentioning unknown block', 422, JSON.stringify({ error: { cause: { name: 'INTERNAL_ERROR' }, message: 'UNKNOWN_BLOCK' } })]
  ]) {
    await t.test(name, async () => {
      const f = fixture({ httpStatus, errorBody });
      await assert.rejects(f.run(), new RegExp(`HTTP ${httpStatus}`));
      assert.ok(!f.calls.some(call => call.params.block_id === 102));
      assert.deepEqual(f.epochs, { 300: f.cached });
      assert.equal(f.saved.length, 0);
    });
  }
});

test('NEAR archive still verifies the parent link after skipping an absent block', async () => {
  const f = fixture({ brokenLink: true });
  await assert.rejects(f.run(), /NEAR epoch history has a gap/);
  assert.deepEqual(f.epochs, { 300: f.cached });
  assert.equal(f.saved.length, 0);
});
