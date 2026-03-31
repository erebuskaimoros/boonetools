/**
 * THORNode API Client
 *
 * Provider Strategy:
 * - THORChain Network (thornode.thorchain.network): Official endpoint, generous rate limits
 * - Liquify (thornode.thorchain.liquify.com): Fallback, updates every 6 seconds
 */

import { fromBaseUnit } from '../utils/blockchain.js';

/**
 * API Provider configurations
 */
export const PROVIDERS = {
  thorchain: {
    name: 'thorchain',
    base: 'https://thornode.thorchain.network',
    supportsBlockHeight: true,
    updateFrequency: 6000,
    priority: 1
  },
  liquify: {
    name: 'liquify',
    base: 'https://thornode.thorchain.liquify.com',
    updateFrequency: 6000,
    priority: 2
  }
};

/**
 * THORNode API Client class
 */
class ThorNodeClient {
  constructor() {
    this.failureCount = {
      thorchain: 0,
      liquify: 0
    };
    this.maxFailures = 3;
    this.cache = new Map();
    this.cacheTTL = 5000;
  }

  clearCache() {
    this.cache.clear();
  }

  resetFailures() {
    this.failureCount.thorchain = 0;
    this.failureCount.liquify = 0;
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

    // Determine providers to try (in order)
    const providers = blockHeight
      ? [PROVIDERS.thorchain]
      : [PROVIDERS.thorchain, PROVIDERS.liquify];

    let lastError = null;

    for (const provider of providers) {
      try {
        let url = `${provider.base}${path}`;

        // Add block height for providers that support height-aware queries.
        if (blockHeight && provider.supportsBlockHeight) {
          const separator = url.includes('?') ? '&' : '?';
          url += `${separator}height=${blockHeight}`;
        }

        const response = await fetch(url, {
          headers: { ...(provider.headers || {}), ...fetchOptions.headers },
          ...fetchOptions
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = parseJson ? await response.json() : await response.text();

        // Cache successful response
        if (cache) {
          this.cache.set(cacheKey, { data, timestamp: Date.now() });
        }

        if (provider.name in this.failureCount) {
          this.failureCount[provider.name] = 0;
        }

        return data;
      } catch (error) {
        lastError = error;
        console.warn(`THORNode fetch failed for ${provider.name}${path}:`, error.message);

        if (provider.name in this.failureCount) {
          this.failureCount[provider.name]++;
        }
      }
    }

    // All providers failed
    throw new Error(`All THORNode providers failed for ${path}: ${lastError?.message}`);
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
  liquify: PROVIDERS.liquify.base
};
