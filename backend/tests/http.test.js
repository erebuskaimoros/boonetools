import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRoutePath, parseIntegerParam } from '../src/lib/http.js';
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

test('toIsoString formats UTC timestamps with +00:00 to match Supabase responses', () => {
  assert.equal(toIsoString('2026-04-01T11:42:54.143Z'), '2026-04-01T11:42:54.143+00:00');
  assert.equal(toIsoString(new Date('2026-04-01T11:42:54.143Z')), '2026-04-01T11:42:54.143+00:00');
});
