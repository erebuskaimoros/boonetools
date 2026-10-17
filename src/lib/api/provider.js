// Browser compatibility facade for the same transport used by the backend.
import { NATIVESWAP_THORNODE, NATIVESWAP_RPC } from '../../../shared/thorchain-providers.js';

// NativeSwap allows simple cross-origin GETs but rejects x-client-id preflights.
// Keep Liquify's identification header without preventing browser failover.
export function browserProviderHeaders(base, headers = {}) {
  return {
    ...([NATIVESWAP_THORNODE, NATIVESWAP_RPC].includes(base) ? {} : { 'x-client-id': 'BooneTools' }),
    ...headers
  };
}

export {
  ProviderRequestError,
  isProviderChallengeResponse,
  requestFromProviders
} from '../../../shared/provider-client.js';
