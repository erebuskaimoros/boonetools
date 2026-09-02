import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisiblePoll } from '../src/lib/utils/visible-poll.js';

function harness() {
  const listeners = new Set();
  const scheduled = new Map();
  let id = 0;
  const document = { visibilityState: 'visible',
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn) };
  return { document, scheduled, listeners,
    setTimeout: (fn) => { scheduled.set(++id, fn); return id; },
    clearTimeout: (key) => scheduled.delete(key),
    visibility(value) { document.visibilityState = value; for (const fn of listeners) fn(); },
    async tick() { const callbacks = [...scheduled.values()]; scheduled.clear(); await Promise.all(callbacks.map((fn) => fn())); }
  };
}

test('polling pauses while hidden and immediately refreshes when visible', async () => {
  const env = harness(); let calls = 0;
  const poll = createVisiblePoll(async () => { calls += 1; }, { ...env, intervalMs: 100 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  env.visibility('hidden');
  await env.tick(); assert.equal(calls, 1);
  assert.equal(env.scheduled.size, 0);
  env.visibility('visible'); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 2);
  poll.stop(); assert.equal(env.listeners.size, 0); assert.equal(env.scheduled.size, 0);
});

test('polling coalesces visibility and manual triggers while a request runs', async () => {
  const env = harness(); let release; let calls = 0;
  const poll = createVisiblePoll(() => { calls += 1; return new Promise((resolve) => { release = resolve; }); }, { ...env, intervalMs: 100 });
  env.visibility('hidden'); env.visibility('visible'); poll.refresh();
  assert.equal(calls, 1);
  poll.stop(); release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(env.scheduled.size, 0);
});
