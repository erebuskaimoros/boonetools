/**
 * THORNode API Client
 *
 * Provider Strategy:
 * - Liquify Gateway (gateway.liquify.com/chain/thorchain_api): Primary public endpoint
 * - THORChain Network (thornode.thorchain.network): Official fallback endpoint
 */

import { fromBaseUnit } from '../utils/blockchain.js';
import { requestFromProviders } from './provider.js';

/**
 * API Provider configurations
 */
const DEV_THORNODE_BASES = {
  primary: '/__thornode_primary',
  fallback: '/__thornode_fallback'
};

export const PROVIDERS = {
  thorchain: {
    name: 'liquify',
    base: import.meta.env.DEV
      ? DEV_THORNODE_BASES.primary
      : 'https://gateway.liquify.com/chain/thorchain_api',
    supportsBlockHeight: true,
    updateFrequency: 6000,
    priority: 1
  },
  fallback: {
    name: 'fallback',
    base: import.meta.env.DEV
      ? DEV_THORNODE_BASES.fallback
      : 'https://thornode.thorchain.network',
    supportsBlockHeight: true,
    updateFrequency: 30000,
    priority: 2
  }
};

/**
 * THORNode API Client class
 */
class ThorNodeClient {
  constructor() {
    this.failureCount = {
      liquify: 0,
      fallback: 0
    };
    this.maxFailures = 3;
    this.cache = new Map();
    this.inflight = new Map();
    this.cacheTTL = 5000;
  }

  clearCache() {
    this.cache.clear();
  }

  resetFailures() {
    this.failureCount.liquify = 0;
    this.failureCount.fallback = 0;
  }

  /**
   * Fetch from THORNode with automatic failover
   * @param {string} path - API endpoint path (e.g., '/thorchain/network')
   * @param {Object} options - Fetch options
   * @returns {Promise<any>} Response data
   */
  async fetch(path, options = {}) {
    const {
      cache = true,
      blockHeight,
      parseJson = true,
      realtime = true,
      timeoutMs = 10000,
      fetchImpl = globalThis.fetch,
      ...fetchOptions
    } = options;

    // Build cache key
    const cacheKey = `${path}:${blockHeight || 'latest'}`;

    // Check cache first
    if (cache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.data;
      }
      // Cache expired, remove it
      this.cache.delete(cacheKey);
    }

    if (cache && this.inflight.has(cacheKey)) {
      return this.inflight.get(cacheKey);
    }

    let requestPath = path;
    if (blockHeight) {
      const separator = requestPath.includes('?') ? '&' : '?';
      requestPath += `${separator}height=${encodeURIComponent(blockHeight)}`;
    }

    const pending = requestFromProviders({
      bases: [PROVIDERS.thorchain.base, PROVIDERS.fallback.base],
      path: requestPath,
      responseType: parseJson ? 'json' : 'text',
      timeoutMs,
      fetchImpl,
      request: fetchOptions,
      shouldStop: (error) => Number(error?.status) === 429
    }).then((data) => {
      if (cache) {
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
      }
      return data;
    }).catch((error) => {
      throw new Error(`All THORNode providers failed for ${path}: ${error.message}`, { cause: error });
    }).finally(() => {
      this.inflight.delete(cacheKey);
    });

    if (cache) this.inflight.set(cacheKey, pending);
    return pending;
  }

  // ============================================
  // Convenience methods for common endpoints
  // ============================================

  /**
   * Get network data (includes RUNE price)
   * @param {Object} options - Fetch options
   */
  async getNetwork(options = {}) {
    return this.fetch('/thorchain/network', options);
  }

  /**
   * Get RUNE price in USD
   * @param {Object} options - Fetch options
   * @returns {Promise<number>} RUNE price
   */
  async getRunePrice(options = {}) {
    const network = await this.getNetwork(options);
    return fromBaseUnit(network.rune_price_in_tor);
  }

  /**
   * Get all pools
   * @param {Object} options - Fetch options
   */
  async getPools(options = {}) {
    return this.fetch('/thorchain/pools', options);
  }

  /**
   * Get a specific pool
   * @param {string} asset - Asset identifier
   * @param {Object} options - Fetch options
   */
  async getPool(asset, options = {}) {
    return this.fetch(`/thorchain/pool/${encodeURIComponent(asset)}`, options);
  }

  /**
   * Get all nodes
   * @param {Object} options - Fetch options
   */
  async getNodes(options = {}) {
    return this.fetch('/thorchain/nodes', options);
  }

  /**
   * Get a Mimir value
   * @param {string} key - Mimir key name
   * @param {Object} options - Fetch options
   */
  async getMimir(key, options = {}) {
    const data = await this.fetch(`/thorchain/mimir/key/${key}`, {
      parseJson: false,
      ...options
    });
    return data;
  }

  /**
   * Get all Mimir values
   * @param {Object} options - Fetch options
   */
  async getAllMimir(options = {}) {
    return this.fetch('/thorchain/mimir', options);
  }

  /**
   * Get balance for an address
   * @param {string} address - THORChain address
   * @param {Object} options - Fetch options
   */
  async getBalance(address, options = {}) {
    return this.fetch(`/cosmos/bank/v1beta1/balances/${address}`, options);
  }

  /**
   * Get trade account balances for a THOR address
   * @param {string} address - THORChain address
   * @param {Object} options - Fetch options
   */
  async getTradeAccount(address, options = {}) {
    return this.fetch(`/thorchain/trade/account/${address}`, {
      cache: false,
      ...options
    });
  }

  /**
   * Get liquidity provider data
   * @param {string} pool - Pool asset identifier
   * @param {string} address - LP address
   * @param {Object} options - Fetch options (can include blockHeight for historical)
   */
  async getLiquidityProvider(pool, address, options = {}) {
    return this.fetch(
      `/thorchain/pool/${encodeURIComponent(pool)}/liquidity_provider/${address}`,
      options
    );
  }

  /**
   * Get Asgard vaults
   * @param {Object} options - Fetch options
   */
  async getVaults(options = {}) {
    return this.fetch('/thorchain/vaults/asgard', options);
  }

  /**
   * Get inbound addresses
   * @param {Object} options - Fetch options
   */
  async getInboundAddresses(options = {}) {
    return this.fetch('/thorchain/inbound_addresses', options);
  }

  /**
   * Get constants
   * @param {Object} options - Fetch options
   */
  async getConstants(options = {}) {
    return this.fetch('/thorchain/constants', options);
  }

  /**
   * Get current block status
   * @param {Object} options - Fetch options
   */
  async getStatus(options = {}) {
    return this.fetch('/status', options);
  }

  /**
   * Get swap quote
   * @param {Object} params - Quote parameters
   * @param {Object} options - Fetch options
   */
  async getSwapQuote(params, options = {}) {
    const query = new URLSearchParams(params).toString();
    return this.fetch(`/thorchain/quote/swap?${query}`, options);
  }

  /**
   * Get limit swaps from the queue
   * @param {Object} params - Query params (offset, limit, source_asset, target_asset, sender, sort_by, sort_order)
   * @param {Object} options - Fetch options
   */
  async getLimitSwaps(params = {}, options = {}) {
    const query = new URLSearchParams(params).toString();
    return this.fetch(`/thorchain/queue/limit_swaps${query ? '?' + query : ''}`, { cache: false, ...options });
  }

  /**
   * Get limit swaps summary statistics
   * @param {Object} options - Fetch options
   */
  async getLimitSwapsSummary(options = {}) {
    return this.fetch('/thorchain/queue/limit_swaps/summary', options);
  }

  /**
   * Get limit order quote
   * @param {Object} params - Quote params (from_asset, to_asset, amount, destination, target_out, custom_ttl, affiliate, affiliate_bps)
   * @param {Object} options - Fetch options
   */
  async getLimitQuote(params, options = {}) {
    const query = new URLSearchParams(params).toString();
    return this.fetch(`/thorchain/quote/limit?${query}`, { cache: false, ...options });
  }
}

// Export singleton instance
export const thornode = new ThorNodeClient();

// Export class for testing or custom instances
export { ThorNodeClient };

// Export provider endpoints for direct use if needed
export const THORNODE_ENDPOINTS = {
  thorchain: PROVIDERS.thorchain.base,
  fallback: PROVIDERS.fallback.base
};
