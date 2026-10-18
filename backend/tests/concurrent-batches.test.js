import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { concurrentBatchWindows } from '../src/lib/concurrent-batches.js';

test('independent batches overlap but persistence waits for every started request and remains ordered', async () => {
  const calls = [], release = [];
  const iterator = concurrentBatchWindows([1, 2, 3, 4, 5], async (items) => {
    calls.push(items);
    await new Promise((resolve) => release.push(resolve));
    return items.map((value) => value * 10);
  }, { batchSize: 2, concurrency: 2 });
  const next = iterator.next();
  await tick();
  assert.deepEqual(calls, [[1, 2], [3, 4]]);
  release[1]();
  await tick();
  assert.equal(calls.length, 2);
  release[0]();
  assert.deepEqual((await next).value.map((row) => row.value), [[10, 20], [30, 40]]);
  const last = iterator.next();
  await tick();
  release[2]();
  assert.deepEqual((await last).value[0].value, [50]);
  assert.equal((await iterator.next()).done, true);
});

test('a failed batch cannot abandon its successful peer or start a third batch before the caller decides', async () => {
  let completed = false, release;
  const calls = [];
  const iterator = concurrentBatchWindows([1, 2, 3], async ([value]) => {
    calls.push(value);
    if (value === 1) throw new Error('provider failed');
    await new Promise((resolve) => { release = resolve; });
    completed = true;
    return value;
  });
  const next = iterator.next();
  await tick();
  assert.deepEqual(calls, [1, 2]);
  release();
  const window = (await next).value;
  assert.equal(completed, true);
  assert.equal(window[0].status, 'rejected');
  assert.equal(window[1].value, 2);
  await iterator.return();
  assert.deepEqual(calls, [1, 2]);
});

test('deadline/cancellation stop scheduling new windows without dropping an already settled window', async () => {
  const controller = new AbortController();
  const windows = [];
  for await (const window of concurrentBatchWindows([1, 2, 3, 4], async ([value]) => value, { signal: controller.signal })) {
    windows.push(window);
    controller.abort();
  }
  assert.equal(windows.length, 1);
  assert.equal(windows[0].length, 2);
  const blocked = concurrentBatchWindows([1], () => { throw new Error('must not run'); }, { shouldContinue: () => false });
  assert.equal((await blocked.next()).done, true);
});

test('a synchronous fetch error is settled alongside its peer', async () => {
  const calls = [];
  const iterator = concurrentBatchWindows([1, 2, 3], ([value]) => {
    calls.push(value);
    if (value === 1) throw new Error('synchronous failure');
    return value;
  });
  const { value } = await iterator.next();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(value[0].status, 'rejected');
  assert.equal(value[1].value, 2);
  await iterator.return();
});
