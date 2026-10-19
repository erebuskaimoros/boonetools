import { requestFromProviders as transport } from '../../../shared/provider-client.js';
import { recordProviderMetric } from './acquisition-metrics.js';
import { config } from './config.js';
import { createThorchainProviderPool } from '../../../shared/thorchain-provider-pool.js';
import { midgardBudgetContext, midgardRequestBudget, isMidgardBudgetDeferred } from './midgard-request-budget.js';

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
  const budget = options.midgardBudget === undefined ? midgardRequestBudget : options.midgardBudget;
  const localBudgetError = (error) => isMidgardBudgetDeferred(error) || error?.code === 'MIDGARD_BUDGET_ABORTED';
  return transport({ ...options,
    providerPool: options.providerPool ?? thorchainProviderPool,
    providerMode: options.providerMode ?? (config.thorchainProviderBalancingEnabled ? undefined : 'fallback'),
    fetchImpl: async (url, request) => {
      // This is the actual outbound boundary: pool admission and durable cooldown
      // hooks have already passed. Cache hits and blocked providers spend nothing.
      const budgetContext = budget && midgardBudgetContext(url, options);
      if (budgetContext) {
        try {
          request.signal?.throwIfAborted();
          const receipt = await budget.claim({ ...budgetContext, signal: request.signal });
          if (request.signal?.aborted) {
            await receipt?.cancel?.();
            request.signal.throwIfAborted();
          }
        } catch (error) {
          if (!request.signal?.aborted) throw error;
          // Transport timeout can expire while waiting for DB admission. No
          // upstream attempt happened, so do not blame/cool down the provider.
          throw Object.assign(new Error('Midgard budget admission canceled', { cause: error }), {
            name: 'AbortError', code: 'MIDGARD_BUDGET_ABORTED', skipProvider: true
          });
        }
      }
      try {
        const response = await fetchImpl(url, request);
        recordProviderMetric(url, response.ok ? 'succeeded' : 'failed');
        return response;
      } catch (error) { recordProviderMetric(url, 'failed'); throw error; }
    }, onProviderError: async (error, context) => {
      if (localBudgetError(error)) return;
      if (/cooldown/i.test(error?.name || '') || error?.code === 'PROVIDER_COOLDOWN') recordProviderMetric(context.url, 'cooldown_skipped');
      await options.onProviderError?.(error, context);
    }, shouldStop: (error, context) => {
      return localBudgetError(error) || options.shouldStop?.(error, context);
    }
  });
}
