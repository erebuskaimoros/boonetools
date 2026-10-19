import { createProviderServices } from '../../../shared/provider-services.js';
import { requestFromProviders } from './provider-client.js';
import { config } from './config.js';

export function createBackendProviderServices({ transport = requestFromProviders, services = {}, defaults } = {}) {
  return createProviderServices({ transport, defaults, services: {
    midgard: config.midgardUrls, rpc: config.rpcRestUrls, thornode: config.thornodeUrls, ...services
  } });
}
