import { setTimeout as delay } from 'node:timers/promises';

// Fetch a small window concurrently, then hand every settled result back to
// the caller for serial DB persistence. No background worker survives a throw,
// an aborted collector, or the release of its advisory-lock SQL connection.
export async function* concurrentBatchWindows(items, fetchBatch, { batchSize = 1,
  concurrency = 2, delayMs = 0, signal, shouldContinue = () => true } = {}) {
  batchSize = Math.max(1, Math.trunc(batchSize) || 1);
  concurrency = Math.max(1, Math.min(12, Math.trunc(concurrency) || 1));
  for (let offset = 0; offset < items.length; offset += batchSize * concurrency) {
    if (signal?.aborted || !shouldContinue()) break;
    if (offset && delayMs > 0) await delay(delayMs, undefined, { signal });
    if (signal?.aborted || !shouldContinue()) break;
    const batches = [];
    for (let index = offset; index < Math.min(items.length, offset + batchSize * concurrency); index += batchSize) {
      batches.push(items.slice(index, index + batchSize));
    }
    const settled = await Promise.allSettled(batches.map((batch) => Promise.resolve().then(() => fetchBatch(batch))));
    yield settled.map((result, index) => ({ ...result, items: batches[index] }));
  }
}
