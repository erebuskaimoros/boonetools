import { requestFromProviders as transport } from '../../../shared/provider-client.js';
import { recordProviderMetric } from './acquisition-metrics.js';

export {
  ProviderRequestError,
  isProviderChallengeResponse
} from '../../../shared/provider-client.js';

export function requestFromProviders(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return transport({ ...options, fetchImpl: async (url, request) => {
    try {
      const response = await fetchImpl(url, request);
      recordProviderMetric(url, response.ok ? 'succeeded' : 'failed');
      return response;
    } catch (error) { recordProviderMetric(url, 'failed'); throw error; }
  }, beforeRequest: options.beforeRequest ? async (context) => {
    try { return await options.beforeRequest(context); }
    catch (error) {
      if (/cooldown/i.test(error?.name || '') || error?.code === 'PROVIDER_COOLDOWN') recordProviderMetric(context.url, 'cooldown_skipped');
      throw error;
    }
  } : null });
}
