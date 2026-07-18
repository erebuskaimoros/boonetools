import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFixedWindowRateLimiter,
  getRequestClientId
} from '../src/lib/rate-limit.js';

test('getRequestClientId uses the first trusted proxy address', () => {
  assert.equal(getRequestClientId({
    headers: { 'x-forwarded-for': '203.0.113.8, 127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' }
  }), '203.0.113.8');
});

test('fixed-window limiter rejects excess requests and resets', () => {
  let timestamp = 1_000;
  const check = createFixedWindowRateLimiter({
    windowMs: 10_000,
    maxRequests: 2,
    now: () => timestamp
  });
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

  assert.equal(check(request).allowed, true);
  assert.equal(check(request).allowed, true);
  const limited = check(request);
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfterSeconds, 10);

  timestamp += 10_000;
  assert.equal(check(request).allowed, true);
});

test('fixed-window limiter evicts the oldest live bucket at its memory cap', () => {
  const check = createFixedWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 1,
    maxBuckets: 100,
    now: () => 1_000
  });
  const requestFor = (address) => ({ headers: {}, socket: { remoteAddress: address } });

  assert.equal(check(requestFor('192.0.2.0')).allowed, true);
  for (let index = 1; index <= 100; index += 1) {
    assert.equal(check(requestFor(`192.0.2.${index}`)).allowed, true);
  }

  // The first live bucket was evicted to keep the map bounded, so this client
  // starts a fresh window rather than retaining its previous count forever.
  assert.equal(check(requestFor('192.0.2.0')).allowed, true);
});
