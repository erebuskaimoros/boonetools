import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

const THORNODE_PRIMARY = 'https://thornode.thorchain.network'
const THORNODE_FALLBACK = 'https://gateway.liquify.com/chain/thorchain_api'
const COINGECKO_NETWORK_BY_CHAIN = {
  ETH: 'ethereum',
  BSC: 'binance-smart-chain',
  AVAX: 'avalanche',
  BASE: 'base'
}

function filterForwardHeaders(headers) {
  const forwarded = new Headers()

  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    if (['host', 'connection', 'content-length'].includes(key.toLowerCase())) continue

    if (Array.isArray(value)) {
      for (const entry of value) {
        forwarded.append(key, entry)
      }
      continue
    }

    forwarded.set(key, value)
  }

  return forwarded
}

async function proxyThorNodeRequest(req, res, upstreams, prefix) {
  const upstreamPath = req.url.replace(prefix, '') || '/'
  let lastError = null
  let lastStatus = 502

  for (const upstream of upstreams) {
    try {
      const response = await fetch(`${upstream}${upstreamPath}`, {
        method: req.method,
        headers: filterForwardHeaders(req.headers)
      })

      if (!response.ok) {
        lastStatus = response.status
        lastError = new Error(`HTTP ${response.status} for ${upstream}${upstreamPath}`)
        continue
      }

      const contentType = response.headers.get('content-type')
      if (contentType) {
        res.setHeader('Content-Type', contentType)
      }

      res.statusCode = response.status
      res.end(Buffer.from(await response.arrayBuffer()))
      return true
    } catch (error) {
      lastError = error
    }
  }

  res.statusCode = lastStatus
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: lastError?.message || `Failed to proxy ${upstreamPath}` }))
  return true
}

function createTreasuryLpProxy() {
  const cacheTtlMs = 60_000
  const lpConcurrency = 8
  const tokenPriceCacheTtlMs = 5 * 60_000
  let poolCache = {
    assets: [],
    expiresAt: 0
  }
  const addressCache = new Map()
  const tokenPriceCache = new Map()

  async function fetchJson(path) {
    let lastError = null

    for (const baseUrl of [THORNODE_PRIMARY, THORNODE_FALLBACK]) {
      const response = await fetch(`${baseUrl}${path}`)
      if (response.ok) {
        return response.json()
      }

      lastError = new Error(`HTTP ${response.status} for ${baseUrl}${path}`)
    }

    throw lastError || new Error(`Failed to fetch ${path}`)
  }

  async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length)
    let index = 0

    async function runWorker() {
      while (index < items.length) {
        const currentIndex = index++
        results[currentIndex] = await worker(items[currentIndex], currentIndex)
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker()
    )

    await Promise.all(workers)
    return results
  }

  async function getAvailablePoolAssets() {
    if (Date.now() < poolCache.expiresAt && poolCache.assets.length > 0) {
      return poolCache.assets
    }

    const pools = await fetchJson('/thorchain/pools')
    poolCache = {
      assets: pools.filter((pool) => pool.status === 'Available').map((pool) => pool.asset),
      expiresAt: Date.now() + cacheTtlMs
    }

    return poolCache.assets
  }

  async function scanAddress(address) {
    const cached = addressCache.get(address)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data
    }

    const poolAssets = await getAvailablePoolAssets()
    const results = await mapWithConcurrency(poolAssets, lpConcurrency, async (asset) => {
      try {
        return await fetchJson(
          `/thorchain/pool/${encodeURIComponent(asset)}/liquidity_provider/${address}`
        )
      } catch (error) {
        if (error.message.includes('HTTP 404')) {
          return null
        }
        throw error
      }
    })

    const data = results.filter(Boolean)
    addressCache.set(address, {
      data,
      expiresAt: Date.now() + cacheTtlMs
    })

    return data
  }

  async function fetchCoingeckoTokenPrice(chain, contractAddress) {
    const network = COINGECKO_NETWORK_BY_CHAIN[chain]
    const normalizedContract = contractAddress?.toLowerCase()

    if (!network || !normalizedContract) {
      throw new Error(`Unsupported token price lookup: ${chain}:${contractAddress}`)
    }

    const cacheKey = `${chain}:${normalizedContract}`
    const cached = tokenPriceCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.usd
    }

    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/${network}?contract_addresses=${encodeURIComponent(normalizedContract)}&vs_currencies=usd`
    )

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for CoinGecko ${network}:${normalizedContract}`)
    }

    const payload = await response.json()
    const usd = Number(payload?.[normalizedContract]?.usd ?? 0)
    const value = Number.isFinite(usd) && usd > 0 ? usd : null

    tokenPriceCache.set(cacheKey, {
      usd: value,
      expiresAt: Date.now() + tokenPriceCacheTtlMs
    })

    return value
  }

  return {
    name: 'treasury-lp-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method === 'GET' && req.url?.startsWith('/__thornode_primary')) {
          await proxyThorNodeRequest(
            req,
            res,
            [THORNODE_PRIMARY, THORNODE_FALLBACK],
            '/__thornode_primary'
          )
          return
        }

        if (req.method === 'GET' && req.url?.startsWith('/__thornode_fallback')) {
          await proxyThorNodeRequest(req, res, [THORNODE_FALLBACK], '/__thornode_fallback')
          return
        }

        if (req.method === 'GET' && req.url?.startsWith('/__thornode_archive')) {
          await proxyThorNodeRequest(req, res, [THORNODE_FALLBACK], '/__thornode_archive')
          return
        }

        if (!req.url?.startsWith('/__treasury_lp_scan')) {
          if (!req.url?.startsWith('/__coingecko_token_price')) {
            return next()
          }

          try {
            const requestUrl = new URL(req.url, 'http://localhost')
            const chain = requestUrl.searchParams.get('chain')
            const contract = requestUrl.searchParams.get('contract')

            if (!chain || !contract) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'chain and contract are required' }))
              return
            }

            const usd = await fetchCoingeckoTokenPrice(chain, contract)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ usd }))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: error.message }))
          }
          return
        }

        try {
          const requestUrl = new URL(req.url, 'http://localhost')
          const address = requestUrl.searchParams.get('address')

          if (!address) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'address is required' }))
            return
          }

          const data = await scanAddress(address)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(data))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: error.message }))
        }
      })
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'process'] }),
    createTreasuryLpProxy()
  ],
  base: '',
  server: {
    host: true,
    proxy: {
      '/__thornode_primary': {
        target: THORNODE_PRIMARY,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__thornode_primary/, '')
      },
      '/__thornode_fallback': {
        target: THORNODE_FALLBACK,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__thornode_fallback/, '')
      },
      '/__thornode_archive': {
        target: THORNODE_FALLBACK,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__thornode_archive/, '')
      }
    }
  },
  publicDir: 'public',
  resolve: {
    alias: {
      '$lib': path.resolve('./src/lib'),
      './libsodium-sumo.mjs': path.resolve('./node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs')
    }
  },
  optimizeDeps: {
    exclude: ['libsodium-wrappers-sumo'],
    esbuildOptions: {
      define: { global: 'globalThis' }
    }
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    }
  }
})
