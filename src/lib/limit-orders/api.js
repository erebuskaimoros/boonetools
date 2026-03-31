import { thornode } from '../api/thornode.js';
import { midgard } from '../api/midgard.js';
import { fromBaseUnit, normalizeAsset } from '$lib/utils/blockchain.js';
import { actionDateToMs, normalizeMarketTradeAction } from './model.js';

function normalizeLimitSwapsResponse(data) {
  if (Array.isArray(data)) {
    return { limitSwaps: data, pagination: null };
  }

  return {
    limitSwaps: Array.isArray(data?.limit_swaps) ? data.limit_swaps : [],
    pagination: data?.pagination ?? null
  };
}

function hasNextPage(pagination) {
  return Boolean(pagination?.has_next ?? pagination?.hasNext);
}

function matchesLimitSwapPair(entry, sourceAsset, targetAsset) {
  const swap = entry?.swap;
  const source = normalizeAsset(swap?.tx?.coins?.[0]?.asset ?? '');
  const target = normalizeAsset(swap?.target_asset ?? '');
  const normalizedSource = normalizeAsset(sourceAsset);
  const normalizedTarget = normalizeAsset(targetAsset);

  return (
    (source === normalizedSource && target === normalizedTarget) ||
    (source === normalizedTarget && target === normalizedSource)
  );
}

function getLimitSwapKey(entry) {
  const swap = entry?.swap;
  return [
    swap?.tx?.id || '',
    swap?.tx?.coins?.[0]?.asset || '',
    swap?.tx?.coins?.[0]?.amount || '',
    swap?.target_asset || '',
    swap?.trade_target || ''
  ].join(':');
}

function dedupeLimitSwaps(swaps) {
  const seen = new Set();

  return swaps.filter((entry) => {
    const key = getLimitSwapKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupePairVariants(pairs) {
  const seen = new Set();

  return (Array.isArray(pairs) ? pairs : []).filter((pair) => {
    const sourceAsset = pair?.sourceAsset ?? '';
    const targetAsset = pair?.targetAsset ?? '';
    if (!sourceAsset || !targetAsset) return false;

    const key = `${sourceAsset}|${targetAsset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeAssets(assets) {
  const seen = new Set();

  return (Array.isArray(assets) ? assets : []).filter((asset) => {
    if (!asset || seen.has(asset)) return false;
    seen.add(asset);
    return true;
  });
}

function getActionTradeMatch(action, sourceAsset, targetAsset) {
  const normalizedSource = normalizeAsset(sourceAsset);
  const normalizedTarget = normalizeAsset(targetAsset);

  const inboundTxs = Array.isArray(action?.in) ? action.in : [];
  const outboundTxs = Array.isArray(action?.out) ? action.out : [];

  for (const inboundTx of inboundTxs) {
    const inboundCoins = Array.isArray(inboundTx?.coins) ? inboundTx.coins : [];

    for (const inboundCoin of inboundCoins) {
      const inboundAsset = normalizeAsset(inboundCoin?.asset ?? '');
      if (!inboundAsset) continue;

      for (const outboundTx of outboundTxs) {
        const outboundCoins = Array.isArray(outboundTx?.coins) ? outboundTx.coins : [];

        for (const outboundCoin of outboundCoins) {
          const outboundAsset = normalizeAsset(outboundCoin?.asset ?? '');
          if (!outboundAsset) continue;

          if (
            (inboundAsset === normalizedSource && outboundAsset === normalizedTarget) ||
            (inboundAsset === normalizedTarget && outboundAsset === normalizedSource)
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function dedupeActions(actions) {
  const seen = new Set();

  return actions.filter((action) => {
    const key = [
      action?.in?.[0]?.txID || '',
      action?.date || '',
      action?.metadata?.swap?.memo || '',
      action?.metadata?.swap?.txType || ''
    ].join(':');

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePositiveFloat(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveRunePrice(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeUsdHistory(data, kind) {
  const intervals = Array.isArray(data?.intervals) ? data.intervals : [];

  return intervals
    .map((interval) => {
      const time = Number(interval?.endTime ?? 0) * 1000;
      const close = kind === 'rune'
        ? parsePositiveRunePrice(interval?.runePriceUSD)
        : parsePositiveFloat(interval?.closePriceUSD ?? interval?.assetPriceUSD ?? interval?.openPriceUSD);

      if (!(time > 0) || !(close > 0)) return null;
      return { time, close };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
}

function createUsdPriceLookup(candles) {
  const series = Array.isArray(candles) ? candles : [];

  return (timestampMs) => {
    if (!(timestampMs > 0) || series.length === 0) return null;

    let low = 0;
    let high = series.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candleTime = series[mid].time;

      if (candleTime === timestampMs) {
        return series[mid].close;
      }

      if (candleTime < timestampMs) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const previous = high >= 0 ? series[high] : null;
    const next = low < series.length ? series[low] : null;

    if (!previous && !next) return null;
    if (!previous) return next.close;
    if (!next) return previous.close;

    return Math.abs(timestampMs - previous.time) <= Math.abs(next.time - timestampMs)
      ? previous.close
      : next.close;
  };
}

function getHistoryResolution(fromMs, toMs) {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const spanMs = Math.max(0, toMs - fromMs);

  if (spanMs <= 30 * hour) {
    return { interval: '5min', durationMs: 5 * minute };
  }

  if (spanMs <= 90 * day) {
    return { interval: 'hour', durationMs: hour };
  }

  if (spanMs <= 400 * day) {
    return { interval: 'day', durationMs: day };
  }

  return { interval: 'week', durationMs: week };
}

function getHistoryParams(fromMs, toMs) {
  const { interval, durationMs } = getHistoryResolution(fromMs, toMs);
  const paddedFromMs = Math.max(0, fromMs - (durationMs * 2));
  const paddedToMs = toMs + (durationMs * 2);
  const count = Math.min(400, Math.max(1, Math.ceil((paddedToMs - paddedFromMs) / durationMs) + 1));

  return {
    interval,
    count: String(count),
    from: String(Math.floor(paddedFromMs / 1000)),
    to: String(Math.floor(paddedToMs / 1000))
  };
}

function actionTouchesAsset(action, asset) {
  const normalizedAsset = normalizeAsset(asset);
  if (!normalizedAsset) return false;

  const inboundTxs = Array.isArray(action?.in) ? action.in : [];
  const outboundTxs = Array.isArray(action?.out) ? action.out : [];

  return [...inboundTxs, ...outboundTxs].some((tx) =>
    (Array.isArray(tx?.coins) ? tx.coins : []).some((coin) => normalizeAsset(coin?.asset ?? '') === normalizedAsset)
  );
}

function getRelevantMarketHistoryAssets(sourceAsset, targetAsset) {
  const normalizedSource = normalizeAsset(sourceAsset);
  const normalizedTarget = normalizeAsset(targetAsset);
  const assets = [];

  if (normalizedSource && normalizedSource !== 'THOR.RUNE') {
    assets.push(sourceAsset);
  }

  if (normalizedTarget && normalizedTarget !== 'THOR.RUNE' && normalizedTarget !== normalizedSource) {
    assets.push(targetAsset);
  }

  if (assets.length > 0) return assets;
  if (sourceAsset) return [sourceAsset];
  if (targetAsset) return [targetAsset];
  return [];
}

async function fetchAssetUsdPriceLookup(asset, fromMs, toMs) {
  const normalizedAsset = normalizeAsset(asset);
  if (!normalizedAsset || !(toMs > 0)) return () => null;

  const params = getHistoryParams(fromMs, toMs);

  try {
    const data = normalizedAsset === 'THOR.RUNE'
      ? await midgard.getRuneHistory(params, { cache: false })
      : await midgard.getPoolHistory(asset, params, { cache: false });
    const candles = normalizeUsdHistory(data, normalizedAsset === 'THOR.RUNE' ? 'rune' : 'pool');
    return createUsdPriceLookup(candles);
  } catch (error) {
    console.warn(`Failed to fetch price history for ${asset}:`, error);
    return () => null;
  }
}

async function fetchLimitSwapsPage(params = {}) {
  const data = await thornode.getLimitSwaps(params);
  return normalizeLimitSwapsResponse(data);
}

/**
 * Fetch dashboard data: summary stats, pools, inbound chain status, and RUNE price.
 * @returns {Promise<{ summary: Object, pools: Array, inboundAddresses: Array, runePrice: number }>}
 */
export async function fetchDashboard() {
  const [summary, pools, inboundAddresses, network] = await Promise.all([
    thornode.getLimitSwapsSummary(),
    thornode.getPools(),
    thornode.getInboundAddresses(),
    thornode.getNetwork()
  ]);

  const runePrice = fromBaseUnit(network.rune_price_in_tor);

  return {
    summary,
    pools,
    inboundAddresses: Array.isArray(inboundAddresses) ? inboundAddresses : [],
    runePrice
  };
}

/**
 * Fetch filtered/sorted limit swaps for a specific asset pair.
 * @param {string} sourceAsset - Source asset identifier
 * @param {string} targetAsset - Target asset identifier
 * @param {Object} options - Query options
 * @param {number} [options.offset=0] - Pagination offset
 * @param {number} [options.limit=100] - Max results
 * @param {string} [options.sortBy='ratio'] - Sort field
 * @param {string} [options.sortOrder='asc'] - Sort direction
 * @returns {Promise<Array>}
 */
export async function fetchPairOrders(sourceAsset, targetAsset, options = {}) {
  const {
    offset = 0,
    limit = 100,
    sortBy = 'ratio',
    sortOrder = 'asc',
    pairVariants = []
  } = options;

  const params = {
    offset: String(offset),
    limit: String(limit),
    sort_by: sortBy,
    sort_order: sortOrder
  };

  const variants = dedupePairVariants([
    { sourceAsset, targetAsset },
    ...pairVariants
  ]);

  const responses = await Promise.all(
    variants.flatMap((pair) => ([
      thornode.getLimitSwaps({
        ...params,
        source_asset: pair.sourceAsset,
        target_asset: pair.targetAsset
      }),
      thornode.getLimitSwaps({
        ...params,
        source_asset: pair.targetAsset,
        target_asset: pair.sourceAsset
      })
    ]))
  );

  const swaps = responses.flatMap((data) => normalizeLimitSwapsResponse(data).limitSwaps);

  return dedupeLimitSwaps(swaps);
}

/**
 * Fetch paginated limit swaps with optional filters.
 * @param {Object} options - Query options
 * @param {number} [options.offset] - Pagination offset
 * @param {number} [options.limit] - Max results
 * @param {string} [options.sender] - Filter by sender address
 * @param {string} [options.sortBy] - Sort field
 * @param {string} [options.sortOrder] - Sort direction
 * @returns {Promise<Array>}
 */
export async function fetchAllLimitSwaps(options = {}) {
  const { offset, limit, sender, sortBy, sortOrder } = options;

  const params = {};
  if (offset !== undefined) params.offset = String(offset);
  if (limit !== undefined) params.limit = String(limit);
  if (sender) params.sender = sender;
  if (sortBy) params.sort_by = sortBy;
  if (sortOrder) params.sort_order = sortOrder;

  return fetchLimitSwapsPage(params).then(({ limitSwaps }) => limitSwaps);
}

export async function fetchWalletPairOrders(addresses, sourceAsset, targetAsset, options = {}) {
  const {
    limit = 100,
    sortBy = 'created_height',
    sortOrder = 'desc'
  } = options;

  const uniqueAddresses = Array.from(new Set((addresses || []).filter(Boolean)));
  if (uniqueAddresses.length === 0) return [];

  const swaps = [];

  for (const sender of uniqueAddresses) {
    let offset = 0;

    while (true) {
      const { limitSwaps, pagination } = await fetchLimitSwapsPage({
        offset: String(offset),
        limit: String(limit),
        sender,
        sort_by: sortBy,
        sort_order: sortOrder
      });

      if (limitSwaps.length === 0) break;

      swaps.push(...limitSwaps.filter((entry) => matchesLimitSwapPair(entry, sourceAsset, targetAsset)));

      if (!hasNextPage(pagination)) break;

      offset += limit;
    }
  }

  return dedupeLimitSwaps(swaps);
}

async function fetchTradeHistoryForPair(sourceAsset, targetAsset, options = {}) {
  const {
    addresses = [],
    limit = 50,
    pageSize = 50,
    maxPages = 10,
    txTypes = [],
    assetFilters = [sourceAsset, targetAsset]
  } = options;

  const filteredAddresses = Array.from(new Set((addresses || []).filter(Boolean)));
  const actions = [];
  let offset = 0;
  let pageCount = 0;

  while (actions.length < limit && pageCount < maxPages) {
    const actionAssets = dedupeAssets(assetFilters);
    const params = {
      type: 'swap',
      asset: actionAssets.join(','),
      limit: String(Math.min(pageSize, 50)),
      offset: String(offset)
    };

    if (filteredAddresses.length > 0) {
      params.address = filteredAddresses.join(',');
    }

    if (txTypes.length > 0) {
      params.txType = txTypes.join(',');
    }

    const data = await midgard.getActions(params, { cache: false });
    const pageActions = Array.isArray(data?.actions) ? data.actions : [];

    if (pageActions.length === 0) break;

    actions.push(
      ...pageActions.filter((action) => {
        if (action?.status !== 'success') return false;
        return getActionTradeMatch(action, sourceAsset, targetAsset);
      })
    );

    if (pageActions.length < Math.min(pageSize, 50)) break;

    offset += Math.min(pageSize, 50);
    pageCount += 1;
  }

  return dedupeActions(actions).slice(0, limit);
}

export async function fetchPairTradeHistory(sourceAsset, targetAsset, options = {}) {
  return fetchTradeHistoryForPair(sourceAsset, targetAsset, options);
}

export async function fetchWalletTradeHistory(addresses, sourceAsset, targetAsset, options = {}) {
  return fetchTradeHistoryForPair(sourceAsset, targetAsset, { ...options, addresses });
}

export async function fetchPairMarketHistory(sourceAsset, targetAsset, options = {}) {
  const {
    limit = 50,
    pageSize = 50,
    maxPages = 10,
    fallbackSourcePriceUsd = null,
    fallbackTargetPriceUsd = null,
    relevantAssets = null
  } = options;

  const marketHistoryAssets = dedupeAssets(
    Array.isArray(relevantAssets) && relevantAssets.length > 0
      ? relevantAssets
      : getRelevantMarketHistoryAssets(sourceAsset, targetAsset)
  );
  if (marketHistoryAssets.length === 0) return [];

  const actions = [];
  let offset = 0;
  let pageCount = 0;
  const perPage = Math.min(pageSize, 50);

  while (actions.length < limit && pageCount < maxPages) {
      const data = await midgard.getActions({
      type: 'swap',
      asset: marketHistoryAssets.join(','),
      limit: String(perPage),
      offset: String(offset)
    }, { cache: false });
    const pageActions = Array.isArray(data?.actions) ? data.actions : [];

    if (pageActions.length === 0) break;

    actions.push(
      ...pageActions.filter((action) => (
        action?.status === 'success' &&
        marketHistoryAssets.some((asset) => actionTouchesAsset(action, asset))
      ))
    );

    if (pageActions.length < perPage) break;

    offset += perPage;
    pageCount += 1;
  }

  const dedupedActions = dedupeActions(actions).slice(0, limit);
  if (dedupedActions.length === 0) return [];

  const actionDatesMs = dedupedActions
    .map((action) => actionDateToMs(action?.date))
    .filter((value) => value > 0);

  const fromMs = Math.min(...actionDatesMs, Date.now());
  const toMs = Math.max(...actionDatesMs, Date.now());

  const [getSourcePriceUsdAt, getTargetPriceUsdAt] = await Promise.all([
    fetchAssetUsdPriceLookup(sourceAsset, fromMs, toMs),
    fetchAssetUsdPriceLookup(targetAsset, fromMs, toMs)
  ]);

  return dedupedActions
    .map((action) => normalizeMarketTradeAction(action, {
      sourceAsset,
      targetAsset,
      getSourcePriceUsdAt,
      getTargetPriceUsdAt,
      fallbackSourcePriceUsd,
      fallbackTargetPriceUsd
    }))
    .filter(Boolean)
    .sort((left, right) => right.dateMs - left.dateMs)
    .slice(0, limit);
}

/**
 * Fetch a limit order quote.
 * @param {Object} params - Quote parameters
 * @param {string} params.from_asset - Source asset
 * @param {string} params.to_asset - Target asset
 * @param {string} params.amount - Amount in base units
 * @param {string} params.destination - Destination address
 * @param {string} params.target_out - Target output in base units
 * @param {number} [params.custom_ttl] - Custom TTL in blocks
 * @param {string} [params.affiliate] - Affiliate code
 * @param {string} [params.affiliate_bps] - Affiliate fee in basis points
 * @returns {Promise<Object>}
 */
export async function fetchLimitQuote(params) {
  return thornode.getLimitQuote(params);
}

/**
 * Get the inbound vault address for a specific chain.
 * @param {string} chain - Chain identifier (e.g. 'BTC', 'ETH')
 * @returns {Promise<Object|null>} Inbound address object or null if not found
 */
export async function fetchInboundAddress(chain) {
  const addresses = await thornode.getInboundAddresses();
  const match = (Array.isArray(addresses) ? addresses : []).find(
    (addr) => addr.chain === chain
  );
  return match || null;
}
