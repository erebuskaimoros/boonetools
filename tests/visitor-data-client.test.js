import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSharedVisitorData } from '../src/lib/api/visitor-data.js';

test('cold shared snapshots retry warming responses and return the populated payload', async () => {
  let calls = 0; let waits = 0;
  const value = await fetchSharedVisitorData('/snapshot', { get: async () => {
    if (++calls < 3) throw Object.assign(new Error('warming'), { status: 503 });
    return { observed_at: '2026-09-02T00:00:00Z' };
  }, wait: async () => { waits += 1; } });
  assert.equal(calls, 3); assert.equal(waits, 2); assert.ok(value.observed_at);
});
test('snapshot retries stop at the bound and do not retry validation errors', async () => {
  let calls = 0;
  await assert.rejects(fetchSharedVisitorData('/snapshot', { attempts: 2, get: async () => { calls++; throw Object.assign(new Error('warming'), { status: 503 }); }, wait: async () => {} }), /warming/);
  assert.equal(calls, 2);
  await assert.rejects(fetchSharedVisitorData('/snapshot', { get: async () => { throw Object.assign(new Error('invalid'), { status: 400 }); }, wait: async () => { assert.fail('unexpected retry'); } }), /invalid/);
});

test('hidden pages suspend cold-cache requests until the page becomes visible', async () => {
  const listeners = new Set(); let calls = 0;
  const document = { visibilityState: 'hidden', addEventListener: (_event, listener) => listeners.add(listener), removeEventListener: (_event, listener) => listeners.delete(listener) };
  const pending = fetchSharedVisitorData('/snapshot', { document, get: async () => { calls++; return {}; } });
  await Promise.resolve(); assert.equal(calls, 0);
  document.visibilityState = 'visible'; for (const listener of listeners) listener();
  await pending; assert.equal(calls, 1); assert.equal(listeners.size, 0);
});

test('background refresh waits for a stale shared snapshot to be replaced', async () => {
  let calls = 0; let waits = 0;
  const fresh = await fetchSharedVisitorData('/snapshot', { requireFresh: true,
    get: async () => ({ stale: ++calls === 1, value: calls }), wait: async () => { waits++; } });
  assert.equal(fresh.stale, false); assert.equal(calls, 2); assert.equal(waits, 1);
});
