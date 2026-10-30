import { config } from '../lib/config.js';
import { providerLifecycleHooks } from './provider-cooldown.js';
import { configureRapidSwapProviderLifecycle } from '../../../shared/rapid-swaps/backend.js';
import { requestFromProviders, thorchainProviderPool } from '../lib/provider-client.js';

configureRapidSwapProviderLifecycle({ ...providerLifecycleHooks(), requestFromProviders, providerPool: thorchainProviderPool,
  providerMode: config.thorchainProviderBalancingEnabled ? undefined : 'fallback' }, {
  midgardBases: config.midgardUrls, thornodeBases: config.thornodeUrls, clientId: config.providerClientId
});

export {
  ACTION_PAGE_LIMIT,
  DIRECT_RESOLUTION_HEIGHT_BUFFER,
  RECENT_SCAN_HEIGHT_BUFFER,
  fetchRapidSwapPriceIndex,
  fetchRapidSwapRows,
  fetchRapidSwapSourceStatus,
  fetchThorchainTx,
  getRapidSwapRateLimitCooldownMs,
  isRapidSwapRateLimitError,
  resolveRapidSwapHint,
  enrichRapidSwapHint
} from '../../../shared/rapid-swaps/backend.js';

export {
  buildRapidSwapCanonicalScanPlan,
  mergeRapidSwapRowsByTxId,
  shouldSkipRapidSwapCanonicalScanForHealthyListener,
  summarizeRapidSwapCanonicalScan
} from '../../../shared/rapid-swaps/ingestion.js';

export {
  normalizeRapidSwapHint,
  RAPID_SWAP_CANDIDATE_STATUS
} from '../../../shared/rapid-swaps/reconciliation.js';
