import { requestFromProviders } from './provider-client.js';
import { providerLifecycleHooks } from '../shared/provider-cooldown.js';

// For configured, non-THORChain endpoints (CMC, DeFiLlama). Keep HTTP parsing,
// deadlines, Retry-After, cooldowns and attempt metrics at the same boundary.
export function requestProviderJson(url, { headers, signal, timeoutMs = 30_000,
  cooldownClient, sharedCooldown, scope, transport = requestFromProviders, ...options } = {}) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Unsupported provider URL');
  }
  return transport({ ...options, bases: [parsed.origin], path: `${parsed.pathname}${parsed.search}`,
    timeoutMs, headers, request: { signal },
    ...providerLifecycleHooks({ client: cooldownClient, enabled: sharedCooldown, scope }) });
}
