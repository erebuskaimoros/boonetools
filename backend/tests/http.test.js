import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRoutePath, parseIntegerParam, sendResponse } from '../src/lib/http.js';
import { toIsoString } from '../src/lib/utils.js';

test('normalizeRoutePath strips the functions/v1 prefix', () => {
  assert.equal(normalizeRoutePath('/functions/v1/nodeop-meta'), '/nodeop-meta');
  assert.equal(normalizeRoutePath('/health'), '/health');
});

test('parseIntegerParam clamps values within bounds', () => {
  assert.equal(parseIntegerParam('20', 10, { min: 1, max: 10 }), 10);
  assert.equal(parseIntegerParam('-5', 10, { min: 1, max: 10 }), 1);
  assert.equal(parseIntegerParam('3', 10, { min: 1, max: 10 }), 3);
});

test('toIsoString formats UTC timestamps with an explicit +00:00 offset', () => {
  assert.equal(toIsoString('2026-04-01T11:42:54.143Z'), '2026-04-01T11:42:54.143+00:00');
  assert.equal(toIsoString(new Date('2026-04-01T11:42:54.143Z')), '2026-04-01T11:42:54.143+00:00');
});

test('sendResponse reports bytes and omits bodies for 304 responses', () => {
  const calls = [];
  const response = {
    writeHead(status, headers) {
      calls.push({ status, headers });
    },
    end(payload) {
      calls.push({ payload });
    }
  };

  const written = sendResponse(response, {
    status: 304,
    headers: { ETag: '"snapshot-1"' }
  });

  assert.deepEqual(written, { status: 304, bytes: 0 });
  assert.equal(calls[0].headers.ETag, '"snapshot-1"');
  assert.equal(calls[0].headers['Content-Type'], undefined);
  assert.equal(calls[1].payload, '');
});

test('sendResponse sets an exact JSON content length', () => {
  let headers;
  let payload;
  const response = {
    writeHead(_status, value) { headers = value; },
    end(value) { payload = value; }
  };

  const written = sendResponse(response, { status: 200, body: { ok: true } });
  assert.equal(headers['Content-Length'], String(Buffer.byteLength(payload)));
  assert.equal(written.bytes, Buffer.byteLength('{"ok":true}'));
});
