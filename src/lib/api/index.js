/**
 * API index - re-exports all API clients
 *
 * Usage:
 *   import { thornode, midgard, THORNODE_ENDPOINTS } from '$lib/api';
 */

// THORNode client
export {
  thornode,
  ThorNodeClient,
  PROVIDERS,
  THORNODE_ENDPOINTS
} from './thornode.js';

// Midgard client
export {
  midgard,
  MidgardClient,
  MIDGARD_BASE
} from './midgard.js';

// BooneTools application backend client
export {
  booneToolsApi,
  booneToolsApiConfig,
  BOONETOOLS_API_META,
  BooneToolsApiError,
  createBooneToolsApiClient,
  getBooneToolsApiMeta,
  normalizeBooneToolsApiPayload,
  resolveBooneToolsApiConfig
} from './boonetools.js';

export {
  ProviderRequestError,
  isProviderChallengeResponse,
  requestFromProviders
} from './provider.js';

/**
 * All endpoint constants for reference
 */
export const ENDPOINTS = {
  thornode: {
    thorchain: 'https://gateway.liquify.com/chain/thorchain_api'
  },
  midgard: 'https://gateway.liquify.com/chain/thorchain_midgard/v2',
  coingecko: 'https://api.coingecko.com/api/v3'
};
