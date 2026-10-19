import { requestFromProviders } from './provider-client.js';
import { MIDGARD_PUBLIC_URLS, RPC_PUBLIC_URLS, THORNODE_PUBLIC_URLS } from './thorchain-providers.js';

export const PUBLIC_PROVIDER_SERVICES = Object.freeze({
  midgard: MIDGARD_PUBLIC_URLS, rpc: RPC_PUBLIC_URLS, thornode: THORNODE_PUBLIC_URLS
});

// Runtime-neutral: only the backend composition root supplies private bases,
// durable budgets and lifecycle hooks. Callers select a service, never a host.
export function createProviderServices({ transport = requestFromProviders,
  services = PUBLIC_PROVIDER_SERVICES, defaults = {} } = {}) {
  const routes = Object.fromEntries(Object.entries(services).map(([service, bases]) => [service,
    Object.freeze([...new Set(bases.map(base => String(base).replace(/\/+$/, '')))])]));
  return (service, path, options = {}) => {
    const bases = Object.hasOwn(routes, service) && routes[service];
    if (!bases?.length) throw new Error('Provider service is not configured');
    if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\\#]/.test(path)
      || bases.some(base => {
        const target = new URL(`${base}${path}`), origin = new URL(base);
        return target.origin !== origin.origin || !target.pathname.startsWith(`${origin.pathname.replace(/\/+$/, '')}/`);
      })) throw new Error('Provider route must stay within its service base');
    return transport({ ...defaults, ...options,
      headers: { ...defaults.headers, ...options.headers }, bases, path });
  };
}
