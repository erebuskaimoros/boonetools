import { requestFromProviders as transport } from '../../../shared/provider-client.js';
import { recordProviderMetric } from './acquisition-metrics.js';
import { config } from './config.js';
import { createThorchainProviderPool } from '../../../shared/thorchain-provider-pool.js';

export const thorchainProviderPool = createThorchainProviderPool({
  maxConcurrent: config.thorchainProviderConcurrency,
  failureCooldownMs: config.providerFailureCooldownMs,
  rateLimitCooldownMs: config.providerRateLimitCooldownMs
});

export {
  ProviderRequestError,
  isProviderChallengeResponse
} from '../../../shared/provider-client.js';

export function requestFromProviders(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return transport({ ...options,
    providerPool: options.providerPool ?? thorchainProviderPool,
    providerMode: options.providerMode ?? (config.thorchainProviderBalancingEnabled ? undefined : 'fallback'),
    fetchImpl: async (url, request) => {
    try {
      const response = await fetchImpl(url, request);
      recordProviderMetric(url, response.ok ? 'succeeded' : 'failed');
      return response;
    } catch (error) { recordProviderMetric(url, 'failed'); throw error; }
  }, onProviderError: async (error, context) => {
    if (/cooldown/i.test(error?.name || '') || error?.code === 'PROVIDER_COOLDOWN') recordProviderMetric(context.url, 'cooldown_skipped');
    await options.onProviderError?.(error, context);
  } });
}
