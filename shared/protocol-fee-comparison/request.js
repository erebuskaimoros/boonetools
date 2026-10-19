import { requestFromProviders } from '../provider-client.js';
import { createProviderServices } from '../provider-services.js';
import { LLAMA_API, LLAMA_COINS, NEAR_REVENUE, CHAINFLIP_RPC, NEAR_RPC, NEAR_TRANSFERS_ORIGIN } from '../external-providers.js';

const ORIGINS = new Set([LLAMA_API, LLAMA_COINS, NEAR_REVENUE, CHAINFLIP_RPC, NEAR_RPC, NEAR_TRANSFERS_ORIGIN]);

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
export function createComparisonRequest({ transport = requestFromProviders, hooks = {}, services } = {}) {
  const serviceRequest = services || createProviderServices({ transport });
  let nearQueue = Promise.resolve(), lastNearRequest = 0;
  return (url, { service, method = 'GET', body, responseType = 'json', signal } = {}) => {
    const parsed = service ? null : new URL(url);
    if (service ? service !== 'midgard' : !ORIGINS.has(parsed.origin)) throw new Error('Comparison provider not allowlisted');
    const run = () => {
      signal?.throwIfAborted();
      const options = { timeoutMs: 45000,
        responseType, allowHtml: parsed?.origin === NEAR_REVENUE && responseType === 'text',
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
      };
      return service ? serviceRequest(service, url, options)
        : transport({ ...options, bases: [parsed.origin], path: `${parsed.pathname}${parsed.search}` });
    };
    if (!parsed?.hostname.endsWith('.fastnear.com')) return run();
    const pending = nearQueue.then(async () => {
      signal?.throwIfAborted();
      const delay = Math.max(0, 1200 - (Date.now() - lastNearRequest));
      if (delay) await pacedWait(delay, signal);
      lastNearRequest = Date.now();
      return run();
    });
    nearQueue = pending.catch(() => {});
    return pending;
  };
}
