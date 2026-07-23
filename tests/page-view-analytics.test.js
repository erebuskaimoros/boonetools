import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPageViewEndpoint,
  isDoNotTrackEnabled,
  trackFirstPartyPageView
} from '../src/lib/page-view-analytics.js';

test('buildPageViewEndpoint accepts only normalized application slugs', () => {
  assert.equal(buildPageViewEndpoint('status'), '/_analytics/page-view/status');
  assert.equal(
    buildPageViewEndpoint('rapid-swaps', '/boonetools/'),
    '/boonetools/_analytics/page-view/rapid-swaps'
  );
  assert.equal(buildPageViewEndpoint('../admin'), null);
  assert.equal(buildPageViewEndpoint('status?debug=1'), null);
});

test('isDoNotTrackEnabled recognizes common browser signals', () => {
  assert.equal(isDoNotTrackEnabled({ doNotTrack: '1' }), true);
  assert.equal(isDoNotTrackEnabled({ doNotTrack: 'yes' }), true);
  assert.equal(isDoNotTrackEnabled({ doNotTrack: '0' }), false);
});

test('trackFirstPartyPageView sends a credential-free same-origin event', async () => {
  const requests = [];
  const tracked = trackFirstPartyPageView('vault-explorer', {
    navigatorRef: { doNotTrack: '0' },
    fetchRef: async (...args) => {
      requests.push(args);
      return { ok: true };
    }
  });

  assert.equal(tracked, true);
  assert.deepEqual(requests, [[
    '/_analytics/page-view/vault-explorer',
    {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      keepalive: true,
      referrerPolicy: 'no-referrer'
    }
  ]]);
});

test('trackFirstPartyPageView skips desktop embeds and Do Not Track visitors', () => {
  let calls = 0;
  const fetchRef = async () => {
    calls += 1;
  };

  assert.equal(trackFirstPartyPageView('status', {
    isDesktopApp: true,
    navigatorRef: { doNotTrack: '0' },
    fetchRef
  }), false);
  assert.equal(trackFirstPartyPageView('status', {
    navigatorRef: { doNotTrack: '1' },
    fetchRef
  }), false);
  assert.equal(calls, 0);
});
