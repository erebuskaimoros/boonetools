import { booneToolsApi } from './boonetools.js';

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function waitUntilVisible(document, signal) {
  if (!document || document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { document.removeEventListener('visibilitychange', visible); signal?.removeEventListener('abort', abort); };
    const visible = () => { if (document.visibilityState !== 'hidden') { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    document.addEventListener('visibilitychange', visible);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** A queued cold snapshot normally becomes available at the next minute tick. */
export async function fetchSharedVisitorData(route, options = {}) {
  const get = options.get || ((path, args) => booneToolsApi.get(path, args));
  const wait = options.wait || waitForRetry;
  const attempts = Math.min(25, Math.max(1, Number(options.attempts) || 19));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await waitUntilVisible(options.document || globalThis.document, options.signal);
    try {
      const payload = await get(route, { query: options.query, signal: options.signal, cache: 'no-cache' });
      if (options.requireFresh && payload?.stale) throw Object.assign(new Error('Shared data is refreshing. Showing the last observation.'), { status: 503 });
      return payload;
    }
    catch (error) {
      if (error?.status !== 503 || attempt + 1 >= attempts) throw error;
      await wait(5000, options.signal);
    }
  }
}
