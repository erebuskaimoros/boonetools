import assert from 'node:assert/strict';
import test from 'node:test';

import viteConfig, { THORNODE_ARCHIVE, proxyThorNodeRequest } from '../vite.config.js';
import { THORNODE_PUBLIC_URLS, NATIVESWAP_THORNODE } from '../shared/thorchain-providers.js';

test('the development archive proxy targets the configured archive provider', () => {
  assert.equal(THORNODE_ARCHIVE, THORNODE_PUBLIC_URLS[0]);
  assert.equal(viteConfig.server.proxy['/__thornode_archive'].target, THORNODE_ARCHIVE);
});

test('the development fallback proxy targets NativeSwap and preserves request paths', async (t) => {
  assert.equal(viteConfig.server.proxy['/__thornode_fallback'].target, NATIVESWAP_THORNODE);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return url.startsWith(THORNODE_PUBLIC_URLS[0])
      ? new Response('unavailable', { status: 503 }) : Response.json({ ok: true });
  });
  const result = { setHeader() {}, end(body) { this.body = JSON.parse(String(body)); } };
  await proxyThorNodeRequest({ url: '/__thornode_archive/thorchain/network?height=123', method: 'GET', headers: {} },
    result, THORNODE_PUBLIC_URLS, '/__thornode_archive');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.deepEqual(calls, THORNODE_PUBLIC_URLS.map(base => `${base}/thorchain/network?height=123`));
});

test('the development proxy retains protocol error details needed to distinguish absent stakes from outages', async (t) => {
  const message = "fail to tcy staker: TCYStaker doesn't exist: thor1example";
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 2, message }, { status: 400 }));
  const result = { setHeader() {}, end(body) { this.body = JSON.parse(String(body)); } };
  await proxyThorNodeRequest({ url: '/__thornode_primary/thorchain/tcy_staker/thor1example', method: 'GET', headers: {} },
    result, ['https://thornode.example.test'], '/__thornode_primary');
  assert.equal(result.statusCode, 400);
  assert.ok(JSON.stringify(result.body).includes(message), 'protocol absence must survive the development proxy');
});
