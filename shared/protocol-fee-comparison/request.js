import { requestFromProviders } from '../provider-client.js';

const ORIGINS = new Set(['https://gateway.liquify.com', 'https://api.llama.fi', 'https://coins.llama.fi',
  'https://revenue.near.org', 'https://mainnet-archive.chainflip.io',
  'https://archival-rpc.mainnet.fastnear.com', 'https://transfers.main.fastnear.com', 'https://api.nearblocks.io']);

function pacedWait(milliseconds, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Runtime-neutral transport: production injects metrics and DB cooldown hooks;
// Vite must not load backend configuration, credentials or package dependencies.
export function createComparisonRequest({ transport = requestFromProviders, hooks = {} } = {}) {
  const queues = new Map();
  return (url, { method = 'GET', body, responseType = 'json', signal } = {}) => {
    const parsed = new URL(url);
    if (!ORIGINS.has(parsed.origin)) throw new Error('Comparison provider not allowlisted');
    const run = () => {
      signal?.throwIfAborted();
      return transport({ bases: [parsed.origin], path: `${parsed.pathname}${parsed.search}`, timeoutMs: 45000,
        responseType, allowHtml: parsed.origin === 'https://revenue.near.org' && responseType === 'text',
        request: { method, signal, ...(body ? { body: JSON.stringify(body) } : {}) },
        headers: { Accept: responseType === 'text' ? 'text/html' : 'application/json', 'Content-Type': 'application/json', 'x-client-id': 'BooneTools-ProtocolComparison' },
        ...hooks,
        beforeRequest: async (context) => {
          signal?.throwIfAborted();
          await hooks.beforeRequest?.(context);
          signal?.throwIfAborted();
        },
        // A collector deadline is not a failing provider or a cooldown trigger.
        onProviderError: (error, context) => signal?.aborted && (error === signal.reason || error.name === 'AbortError')
          ? undefined : hooks.onProviderError?.(error, context)
      });
    };
    if (!parsed.hostname.endsWith('.fastnear.com') && parsed.hostname !== 'api.nearblocks.io') return run();
    const key = parsed.hostname === 'api.nearblocks.io' ? 'nearblocks' : 'fastnear';
    if (!queues.has(key)) queues.set(key, { pending: Promise.resolve(), lastRequest: 0 });
    const queue = queues.get(key);
    const pending = queue.pending.then(async () => {
      signal?.throwIfAborted();
      const delay = Math.max(0, 1200 - (Date.now() - queue.lastRequest));
      if (delay) await pacedWait(delay, signal);
      queue.lastRequest = Date.now();
      return run();
    });
    queue.pending = pending.catch(() => {});
    return pending;
  };
}
