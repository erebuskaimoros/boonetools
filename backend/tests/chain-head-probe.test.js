import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCurrentRpcHead, classifyStreamBlock } from '../src/shared/chain-head-probe.js';

const now = Date.parse('2026-09-23T21:08:35Z');
const status = (height, time, catchingUp = false) => ({ result: { sync_info: {
  latest_block_height: String(height), latest_block_time: time, catching_up: catchingUp
} } });

test('RPC probe prefers the current provider over a successful lagging response', async () => {
  const calls = [];
  const head = await fetchCurrentRpcHead({
    now: () => now,
    rpcUrls: ['https://lagging.test', 'https://current.test'],
    fetchRpc: async (endpoint, _params, options) => {
      calls.push({ endpoint, options });
      return options.rpcUrls[0].includes('lagging')
        ? status(27943798, '2026-09-22T21:08:30Z')
        : status(27957812, '2026-09-23T21:08:30Z');
    }
  });
  assert.equal(head.height, 27957812);
  assert.equal(head.verified_at, new Date(now).toISOString());
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.endpoint === '/status' && call.options.timeoutMs <= 4000));
});

test('RPC probe rejects catching-up nodes, future timestamps, and regression behind the durable head', async () => {
  for (const payload of [
    status(27957812, '2026-09-23T21:08:30Z', true),
    status(27957812, '2026-09-24T21:08:30Z'),
    status(27943798, '2026-09-22T21:08:30Z')
  ]) {
    await assert.rejects(fetchCurrentRpcHead({
      now: () => now, minimumHeight: 27957800, rpcUrls: ['https://rpc.test'], fetchRpc: async () => payload
    }));
  }
});

test('RPC probe permits an unchanged synced head so genuine consensus stalls remain visible', async () => {
  const head = await fetchCurrentRpcHead({
    now: () => now, minimumHeight: 27957812, rpcUrls: ['https://rpc.test'],
    fetchRpc: async () => status(27957812, '2026-09-23T21:00:00Z')
  });
  assert.equal(head.height, 27957812);
  assert.equal(head.catching_up, false);
});

test('stream replay and height regressions reconnect without accepting old blocks as a live head', () => {
  const stale = classifyStreamBlock({ height: 27943798, time: '2026-09-22T21:08:30Z' }, { nowMs: now });
  assert.equal(stale.accept, false);
  assert.equal(stale.reconnect, true);
  const regression = classifyStreamBlock({ height: 10, time: '2026-09-23T21:08:30Z' }, { nowMs: now, lastHeight: 20 });
  assert.equal(regression.accept, false);
  assert.equal(regression.reconnect, true);
  const duplicate = classifyStreamBlock({ height: 20, time: '2026-09-23T21:08:30Z' }, { nowMs: now, lastHeight: 20 });
  assert.equal(duplicate.accept, false);
  assert.equal(duplicate.reconnect, false);
  assert.equal(classifyStreamBlock({ height: 21, time: '2026-09-23T21:08:30Z' }, { nowMs: now, lastHeight: 20 }).accept, true);
});
