import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_V2_MEDIA_TYPE,
  applyApiContract,
  createApiMeta,
  wantsApiSchemaV2
} from '../src/lib/api-contract.js';

test('createApiMeta normalizes timestamp, source, stale state, provenance, and warnings', () => {
  const meta = createApiMeta({
    as_of: '2026-07-17T12:00:00Z',
    source: 'dune',
    source_provenance: ['dune', 'midgard'],
    stale: true,
    warning: 'fallback active'
  }, {
    route: '/rapid-swaps',
    now: '2026-07-17T13:00:00Z'
  });

  assert.deepEqual(meta, {
    schemaVersion: 2,
    asOf: '2026-07-17T12:00:00.000Z',
    source: 'dune',
    provenance: ['dune', 'midgard'],
    stale: true,
    warnings: ['fallback active']
  });
});

test('legacy responses keep their shape and gain additive contract metadata', () => {
  const result = applyApiContract({
    status: 200,
    body: { rows: [1], meta: { featureWindow: '30d' } },
    headers: { 'Cache-Control': 'public, max-age=30' }
  }, {
    route: '/tc-fee-dash',
    now: '2026-07-17T13:00:00Z',
    request: { headers: {} },
    url: new URL('http://localhost/tc-fee-dash')
  });

  assert.deepEqual(result.body.rows, [1]);
  assert.equal(result.body.meta.featureWindow, '30d');
  assert.equal(result.body.meta.schemaVersion, 2);
  assert.equal(result.headers['X-Boone-Schema-Version'], '2');
});

test('schema v2 requests receive the data and meta envelope', () => {
  const request = { headers: { accept: API_V2_MEDIA_TYPE } };
  const url = new URL('http://localhost/rapid-swaps?schema_version=2');
  assert.equal(wantsApiSchemaV2(request, url), true);

  const result = applyApiContract({
    status: 200,
    body: { swaps: [1], meta: { source: 'dune' } },
    headers: {}
  }, {
    route: '/rapid-swaps',
    now: '2026-07-17T13:00:00Z',
    request,
    url
  });

  assert.deepEqual(result.body.data, { swaps: [1] });
  assert.equal(result.body.meta.source, 'dune');
  assert.equal(result.body.meta.schemaVersion, 2);
  assert.equal(result.headers['Content-Type'], API_V2_MEDIA_TYPE);
});

test('error responses remain backward-compatible', () => {
  const result = { status: 404, body: { error: 'Not found' }, headers: {} };
  assert.equal(applyApiContract(result, {
    request: { headers: { accept: API_V2_MEDIA_TYPE } },
    url: new URL('http://localhost/missing?schema_version=2')
  }), result);
});
