/** A single in-flight refresh, suspended in hidden tabs and resumed immediately. */
export function createVisiblePoll(refresh, options = {}) {
  const document = options.document || globalThis.document;
  const schedule = options.setTimeout || globalThis.setTimeout;
  const cancel = options.clearTimeout || globalThis.clearTimeout;
  const intervalMs = Math.max(100, Number(options.intervalMs) || 60_000);
  let timer;
  let running = false;
  let stopped = false;
  const visible = () => !document || document.visibilityState !== 'hidden';
  function later() {
    cancel(timer);
    if (!stopped && visible()) timer = schedule(run, intervalMs);
  }
  async function run() {
    if (stopped || running || !visible()) return;
    cancel(timer);
    running = true;
    try { await refresh(); }
    catch (error) { options.onError?.(error); }
    finally { running = false; later(); }
  }
  function onVisibility() {
    cancel(timer);
    if (visible()) void run();
  }
  document?.addEventListener('visibilitychange', onVisibility);
  if (options.immediate !== false) void run();
  else later();
  return {
    refresh: run,
    stop() { stopped = true; cancel(timer); document?.removeEventListener('visibilitychange', onVisibility); }
  };
}
