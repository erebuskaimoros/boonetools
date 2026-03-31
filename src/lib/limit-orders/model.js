import { fromBaseUnit, normalizeAsset, getAssetType, getChainFromAsset } from '$lib/utils/blockchain.js';

// ============================================
// Price Index
// ============================================

/**
 * Build a Map of asset identifier -> USD price from pool data.
 *
 * Each pool exposes `asset_tor_price` in 1e8 base units (TOR ≈ USD).
 * We store both the raw asset key and the normalized form so callers
 * can look up prices without worrying about contract-address suffixes
 * or separator styles.
 *
 * @param {Array<{ asset: string, asset_tor_price: string|number }>} pools
 * @param {number} runePrice - Current RUNE price in USD
 * @returns {Map<string, number>} asset -> USD price
 */
export function buildPoolPriceIndex(pools, runePrice) {
  /** @type {Map<string, number>} */
  const index = new Map();

  // RUNE is always available
  index.set('THOR.RUNE', runePrice);

  if (!Array.isArray(pools)) return index;

  for (const pool of pools) {
    if (!pool.asset || pool.asset_tor_price == null) continue;

    const usd = fromBaseUnit(pool.asset_tor_price);

    // Store under the raw key returned by the API
    index.set(pool.asset, usd);

    // Also store under the normalized key (no contract address, dot notation)
    const normalized = normalizeAsset(pool.asset);
    if (normalized !== pool.asset) {
      index.set(normalized, usd);
    }
  }

  return index;
}

/**
 * Look up the USD price for an asset from the price index.
 *
 * Tries the normalized form first (most common lookup path), then
 * falls back to the original string.
 *
 * @param {string} asset - Asset identifier (any format)
 * @param {Map<string, number>} priceIndex - From buildPoolPriceIndex
 * @returns {number|null} USD price or null if unknown
 */
export function getAssetPriceUSD(asset, priceIndex) {
  if (!asset || !priceIndex) return null;

  const normalized = normalizeAsset(asset);

  if (priceIndex.has(normalized)) return priceIndex.get(normalized);
  if (priceIndex.has(asset)) return priceIndex.get(asset);

  return null;
}

// ============================================
// Tick Size
// ============================================

/**
 * Compute an appropriate tick size for bucketing prices into levels.
 *
 * The goal is 2-3 significant figures so the orderbook stays readable
 * regardless of the price magnitude.
 *
 * @param {number} price - The reference price
 * @returns {number} Tick size for rounding
 *
 * @example
 * computeTickSize(0.0001234) // ~0.000001
 * computeTickSize(1234.5)    // ~10
 * computeTickSize(0.5)       // ~0.01
 */
export function computeTickSize(price) {
  if (!price || price <= 0) return 1;

  // Find the order of magnitude, then round to 2 sig figs
  const magnitude = Math.floor(Math.log10(price));
  // Tick sits 2 orders below the leading digit
  return Math.pow(10, magnitude - 1);
}

// ============================================
// Order Book
// ============================================

/**
 * @typedef {Object} PriceLevel
 * @property {number} price       - Bucketed price (ratio of target/source in base units)
 * @property {number} totalAmount - Sum of source amounts at this level (base units)
 * @property {number} totalValue  - Sum of source amounts converted to USD
 * @property {number} orderCount  - Number of individual swaps at this level
 * @property {number} cumulative  - Running cumulative depth (set after sorting)
 */

/**
 * @typedef {Object} OrderBook
 * @property {PriceLevel[]} asks    - Sell levels, ascending by price
 * @property {PriceLevel[]} bids    - Buy levels, descending by price
 * @property {number|null}  spread  - Spread as a percentage of the midPrice
 * @property {number|null}  midPrice
 * @property {number|null}  bestAsk
 * @property {number|null}  bestBid
 * @property {number}       maxDepth - Largest cumulative depth (for rendering)
 */

/**
 * Build a two-sided orderbook from raw limit swaps.
 *
 * The function classifies each swap as a bid or ask relative to the
 * provided sourceAsset / targetAsset pair, buckets swaps into price
 * levels using `computeTickSize`, and returns sorted, cumulated sides.
 *
 * @param {Array} swaps        - Raw limit swap objects from the API
 * @param {string} sourceAsset - The "base" asset of the pair
 * @param {string} targetAsset - The "quote" asset of the pair
 * @param {Map<string, number>} priceIndex - From buildPoolPriceIndex
 * @returns {OrderBook}
 */
export function buildOrderBook(swaps, sourceAsset, targetAsset, priceIndex) {
  /** @type {Map<number, PriceLevel>} */
  const bidMap = new Map();
  /** @type {Map<number, PriceLevel>} */
  const askMap = new Map();

  const normalizedSource = normalizeAsset(sourceAsset);
  const normalizedTarget = normalizeAsset(targetAsset);

  const basePrice = getAssetPriceUSD(sourceAsset, priceIndex) ?? 0;

  for (const entry of swaps) {
    const swap = entry?.swap;
    if (!swap) continue;

    const coin = swap.tx?.coins?.[0];
    if (!coin) continue;

    const swapSourceAmount = Number(coin.amount);
    const tradeTarget = Number(swap.trade_target);
    if (!swapSourceAmount || !tradeTarget) continue;

    const swapSource = normalizeAsset(coin.asset);
    const swapTarget = normalizeAsset(swap.target_asset);

    // Normalize both sides onto a conventional base/quote book:
    // asks sell the base asset, bids buy the base asset.
    let side;
    let amount; // base asset amount for depth
    let limitPrice; // quote per base

    if (swapSource === normalizedSource && swapTarget === normalizedTarget) {
      side = 'ask';
      amount = swapSourceAmount;
      limitPrice = tradeTarget / swapSourceAmount;
    } else if (swapSource === normalizedTarget && swapTarget === normalizedSource) {
      side = 'bid';
      amount = tradeTarget;
      limitPrice = tradeTarget > 0 ? swapSourceAmount / tradeTarget : 0;
    } else {
      continue; // Does not belong to this pair
    }

    if (!limitPrice || !amount) continue;

    // Bucket by tick size
    const tick = computeTickSize(limitPrice);
    const bucketed = Math.round(limitPrice / tick) * tick;
    // Round to avoid floating-point drift
    const key = Number(bucketed.toPrecision(10));

    const map = side === 'bid' ? bidMap : askMap;
    const existing = map.get(key);

    if (existing) {
      existing.totalAmount += amount;
      existing.totalValue += amount * basePrice / 1e8; // amount is in base units
      existing.orderCount += 1;
    } else {
      map.set(key, {
        price: key,
        totalAmount: amount,
        totalValue: amount * basePrice / 1e8,
        orderCount: 1,
        cumulative: 0
      });
    }
  }

  // Sort asks ascending, bids descending
  const asks = Array.from(askMap.values()).sort((a, b) => a.price - b.price);
  const bids = Array.from(bidMap.values()).sort((a, b) => b.price - a.price);

  // Cumulative depth
  let cumAsk = 0;
  for (const level of asks) {
    cumAsk += level.totalAmount;
    level.cumulative = cumAsk;
  }

  let cumBid = 0;
  for (const level of bids) {
    cumBid += level.totalAmount;
    level.cumulative = cumBid;
  }

  const bestAsk = asks.length > 0 ? asks[0].price : null;
  const bestBid = bids.length > 0 ? bids[0].price : null;

  let midPrice = null;
  let spread = null;

  if (bestAsk !== null && bestBid !== null) {
    midPrice = (bestAsk + bestBid) / 2;
    spread = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : null;
  }

  const maxDepth = Math.max(cumAsk, cumBid, 0);

  return { asks, bids, spread, midPrice, bestAsk, bestBid, maxDepth };
}

// ============================================
// Normalize Individual Swap
// ============================================

/**
 * Transform a raw API limit swap object into a display-ready format.
 *
 * All amounts are converted from 1e8 base units to human-readable numbers,
 * and USD values are derived from the price index.
 *
 * @param {Object} swap       - Raw limit swap entry from the API
 * @param {Map<string, number>} priceIndex - From buildPoolPriceIndex
 * @returns {Object} Normalized swap object
 */
export function normalizeLimitSwap(swap, priceIndex) {
  const inner = swap?.swap;
  if (!inner) return null;

  const coin = inner.tx?.coins?.[0];
  const sourceAsset = coin?.asset ?? '';
  const targetAsset = inner.target_asset ?? '';
  const sourceAmountRaw = Number(coin?.amount ?? 0);
  const targetAmountRaw = Number(inner.trade_target ?? 0);

  const sourceAmount = fromBaseUnit(sourceAmountRaw);
  const targetAmount = fromBaseUnit(targetAmountRaw);

  const sourcePriceUSD = getAssetPriceUSD(sourceAsset, priceIndex) ?? 0;
  const targetPriceUSD = getAssetPriceUSD(targetAsset, priceIndex) ?? 0;

  const sourceAmountUSD = sourceAmount * sourcePriceUSD;
  const targetAmountUSD = targetAmount * targetPriceUSD;

  // Limit price ratio (unitless): how many target units expected per source unit
  const limitPrice = sourceAmountRaw > 0 ? targetAmountRaw / sourceAmountRaw : 0;

  return {
    txId: inner.tx?.id ?? null,
    sender: swap.sender ?? null,
    sourceAsset,
    targetAsset,
    sourceAmountRaw: String(coin?.amount ?? 0),
    targetAmountRaw: String(inner.trade_target ?? 0),
    sourceAmount,
    targetAmount,
    sourceAmountUSD,
    targetAmountUSD,
    limitPrice,
    initialHeight: swap.initial_height ?? null,
    expiryHeight: swap.expiry_height ?? null,
    ageBlocks: null, // Requires current block height; set by the caller
    memo: inner.tx?.memo ?? null,
    destination: inner.destination ?? null
  };
}

export function getOrderSideForPair(order, sourceAsset, targetAsset) {
  if (!order) return null;

  const source = normalizeAsset(order.sourceAsset);
  const target = normalizeAsset(order.targetAsset);
  const normalizedSource = normalizeAsset(sourceAsset);
  const normalizedTarget = normalizeAsset(targetAsset);

  if (source === normalizedSource && target === normalizedTarget) return 'sell';
  if (source === normalizedTarget && target === normalizedSource) return 'buy';
  return null;
}

export function getOrderDisplayPrice(order, sourceAsset, targetAsset) {
  const side = getOrderSideForPair(order, sourceAsset, targetAsset);
  if (!side) return null;

  if (side === 'sell') return order.limitPrice;
  return order.targetAmount > 0 ? order.sourceAmount / order.targetAmount : null;
}

export function getOrderDisplayAmount(order, sourceAsset, targetAsset) {
  const side = getOrderSideForPair(order, sourceAsset, targetAsset);
  if (!side) return null;

  return side === 'sell' ? order.sourceAmount : order.targetAmount;
}

function findTradeActionMatch(action, sourceAsset, targetAsset) {
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

          const isForward = inboundAsset === normalizedSource && outboundAsset === normalizedTarget;
          const isReverse = inboundAsset === normalizedTarget && outboundAsset === normalizedSource;

          if (isForward || isReverse) {
            return { inboundTx, inboundCoin, outboundTx, outboundCoin, isForward };
          }
        }
      }
    }
  }

  return null;
}

export function actionDateToMs(value) {
  const parsed = Number(value ?? 0);
  if (!(parsed > 0)) return 0;
  if (parsed >= 1e17) return Math.floor(parsed / 1e6); // nanoseconds
  if (parsed >= 1e14) return Math.floor(parsed / 1e3); // microseconds
  if (parsed >= 1e11) return Math.floor(parsed); // milliseconds
  return Math.floor(parsed * 1000); // seconds
}

function getActionCoinMatches(action, asset) {
  const normalizedAsset = normalizeAsset(asset);
  const matches = [];

  const inboundTxs = Array.isArray(action?.in) ? action.in : [];
  const outboundTxs = Array.isArray(action?.out) ? action.out : [];

  for (const tx of inboundTxs) {
    const coins = Array.isArray(tx?.coins) ? tx.coins : [];

    for (const coin of coins) {
      if (normalizeAsset(coin?.asset ?? '') !== normalizedAsset) continue;
      matches.push({ direction: 'in', tx, coin });
    }
  }

  for (const tx of outboundTxs) {
    const coins = Array.isArray(tx?.coins) ? tx.coins : [];

    for (const coin of coins) {
      if (normalizeAsset(coin?.asset ?? '') !== normalizedAsset) continue;
      matches.push({ direction: 'out', tx, coin });
    }
  }

  return matches;
}

function pickPrimaryActionCoinMatch(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return null;

  const rank = (match) => {
    const amount = Number(match?.coin?.amount ?? 0);
    const directionScore = match?.direction === 'out' ? 1 : 0;
    return [directionScore, amount];
  };

  return matches.slice().sort((left, right) => {
    const [leftDirection, leftAmount] = rank(left);
    const [rightDirection, rightAmount] = rank(right);

    if (rightDirection !== leftDirection) return rightDirection - leftDirection;
    return rightAmount - leftAmount;
  })[0];
}

function inferMarketSideFromTouch(role, direction) {
  if (role === 'source') {
    return direction === 'out' ? 'buy' : 'sell';
  }

  return direction === 'in' ? 'buy' : 'sell';
}

export function normalizeTradeActionForPair(action, sourceAsset, targetAsset) {
  const match = findTradeActionMatch(action, sourceAsset, targetAsset);
  if (!match) return null;

  const sourceAmount = fromBaseUnit(match.inboundCoin.amount);
  const targetAmount = fromBaseUnit(match.outboundCoin.amount);

  if (!(sourceAmount > 0) || !(targetAmount > 0)) return null;

  const displaySide = match.isForward ? 'sell' : 'buy';
  const displayPrice = displaySide === 'sell'
    ? targetAmount / sourceAmount
    : sourceAmount / targetAmount;
  const displayAmount = displaySide === 'sell' ? sourceAmount : targetAmount;

  if (!(displayPrice > 0) || !(displayAmount > 0)) return null;

  return {
    txId: match.inboundTx?.txID || match.outboundTx?.txID || null,
    sourceAsset: match.inboundCoin.asset ?? '',
    targetAsset: match.outboundCoin.asset ?? '',
    sourceAmount,
    targetAmount,
    displaySide,
    displayPrice,
    displayAmount,
    status: action?.status ?? null,
    txType: action?.metadata?.swap?.txType ?? null,
    date: action?.date ?? null,
    memo: String(action?.metadata?.swap?.memo || ''),
    isLimitOrder: String(action?.metadata?.swap?.memo || '').startsWith('=<') || action?.txType === 'limitOrder'
  };
}

export function normalizeMarketTradeAction(action, options = {}) {
  const {
    sourceAsset,
    targetAsset,
    getSourcePriceUsdAt = null,
    getTargetPriceUsdAt = null,
    fallbackSourcePriceUsd = null,
    fallbackTargetPriceUsd = null
  } = options;

  const directMatch = findTradeActionMatch(action, sourceAsset, targetAsset);
  const dateMs = actionDateToMs(action?.date);
  const sourcePriceUsd = getSourcePriceUsdAt?.(dateMs) ?? fallbackSourcePriceUsd ?? null;
  const targetPriceUsd = getTargetPriceUsdAt?.(dateMs) ?? fallbackTargetPriceUsd ?? null;
  const pairPriceAtTime = sourcePriceUsd > 0 && targetPriceUsd > 0
    ? sourcePriceUsd / targetPriceUsd
    : null;

  if (directMatch) {
    const sourceAmount = fromBaseUnit(directMatch.inboundCoin.amount);
    const targetAmount = fromBaseUnit(directMatch.outboundCoin.amount);

    if (!(sourceAmount > 0) || !(targetAmount > 0)) return null;

    const displaySide = directMatch.isForward ? 'sell' : 'buy';
    const displayPrice = displaySide === 'sell'
      ? targetAmount / sourceAmount
      : sourceAmount / targetAmount;
    const displayAmount = displaySide === 'sell' ? sourceAmount : targetAmount;
    const displayAmountAsset = sourceAsset;
    const displayValueUsd = sourcePriceUsd > 0 ? displayAmount * sourcePriceUsd : null;

    if (!(displayPrice > 0) || !(displayAmount > 0)) return null;

    return {
      txId: directMatch.inboundTx?.txID || directMatch.outboundTx?.txID || null,
      displaySide,
      displayPrice,
      displayAmount,
      displayAmountAsset,
      displayAmountSymbol: getAssetTicker(displayAmountAsset),
      displayValueUsd,
      date: action?.date ?? null,
      dateMs,
      memo: String(action?.metadata?.swap?.memo || ''),
      txType: action?.metadata?.swap?.txType ?? null,
      isLimitOrder: String(action?.metadata?.swap?.memo || '').startsWith('=<') || action?.txType === 'limitOrder',
      isDirectPair: true
    };
  }

  const sourceMatch = pickPrimaryActionCoinMatch(getActionCoinMatches(action, sourceAsset));
  const targetMatch = pickPrimaryActionCoinMatch(getActionCoinMatches(action, targetAsset));

  let touch = null;

  if (sourceMatch && !targetMatch) {
    touch = { role: 'source', ...sourceMatch };
  } else if (targetMatch && !sourceMatch) {
    touch = { role: 'target', ...targetMatch };
  } else if (sourceMatch && targetMatch) {
    const sourceAmount = Number(sourceMatch.coin?.amount ?? 0);
    const targetAmount = Number(targetMatch.coin?.amount ?? 0);
    touch = sourceAmount >= targetAmount
      ? { role: 'source', ...sourceMatch }
      : { role: 'target', ...targetMatch };
  }

  if (!touch) return null;

  const displayAmount = fromBaseUnit(touch.coin?.amount ?? 0);
  const displayAmountAsset = touch.coin?.asset ?? '';
  const displayPrice = pairPriceAtTime;
  const displayValueUsd = touch.role === 'source'
    ? (sourcePriceUsd > 0 ? displayAmount * sourcePriceUsd : null)
    : (targetPriceUsd > 0 ? displayAmount * targetPriceUsd : null);

  if (!(displayAmount > 0) || !(displayPrice > 0)) return null;

  return {
    txId: touch.tx?.txID || action?.in?.[0]?.txID || action?.out?.[0]?.txID || null,
    displaySide: inferMarketSideFromTouch(touch.role, touch.direction),
    displayPrice,
    displayAmount,
    displayAmountAsset,
    displayAmountSymbol: getAssetTicker(displayAmountAsset),
    displayValueUsd,
    date: action?.date ?? null,
    dateMs,
    memo: String(action?.metadata?.swap?.memo || ''),
    txType: action?.metadata?.swap?.txType ?? null,
    isLimitOrder: String(action?.metadata?.swap?.memo || '').startsWith('=<') || action?.txType === 'limitOrder',
    isDirectPair: false,
    affectsAsset: touch.role
  };
}

// ============================================
// Pair List
// ============================================

/**
 * Stable quote-asset preference used to orient each market onto a single
 * base/quote axis. Lower rank means "more quote-like".
 *
 * This keeps markets stable in the selector instead of flipping orientation
 * based on whichever direction happened to be present in the open-order queue.
 */
const QUOTE_TICKER_PRIORITY = new Map([
  'USDT',
  'USDC',
  'DAI',
  'USDE',
  'USDS',
  'USDP',
  'LUSD',
  'GUSD',
  'BUSD',
  'BTC',
  'ETH',
  'BNB',
  'AVAX',
  'SOL',
  'ATOM',
  'RUNE'
].map((ticker, index) => [ticker, index]));

const STABLE_TICKERS = new Set([
  'USDT',
  'USDC',
  'DAI',
  'USDE',
  'USDS',
  'USDP',
  'LUSD',
  'GUSD',
  'BUSD'
]);

function getAssetTicker(asset) {
  const normalized = normalizeAsset(asset);
  const [chain = '', symbol = ''] = normalized.split('.');
  return (symbol || chain || '').toUpperCase();
}

function isRuneAsset(asset) {
  return normalizeAsset(asset) === 'THOR.RUNE' || getAssetTicker(asset) === 'RUNE';
}

function isStableAsset(asset) {
  return STABLE_TICKERS.has(getAssetTicker(asset));
}

function getQuotePriority(asset) {
  return QUOTE_TICKER_PRIORITY.get(getAssetTicker(asset)) ?? Number.MAX_SAFE_INTEGER;
}

function orientMarketPair(assetA, assetB, priceIndex) {
  const assetAIsRune = isRuneAsset(assetA);
  const assetBIsRune = isRuneAsset(assetB);
  const assetAIsStable = isStableAsset(assetA);
  const assetBIsStable = isStableAsset(assetB);

  if (assetAIsRune !== assetBIsRune) {
    return assetAIsRune
      ? { sourceAsset: assetA, targetAsset: assetB }
      : { sourceAsset: assetB, targetAsset: assetA };
  }

  if (assetAIsStable !== assetBIsStable) {
    return assetAIsStable
      ? { sourceAsset: assetB, targetAsset: assetA }
      : { sourceAsset: assetA, targetAsset: assetB };
  }

  const priorityA = getQuotePriority(assetA);
  const priorityB = getQuotePriority(assetB);

  if (priorityA !== priorityB) {
    return priorityA < priorityB
      ? { sourceAsset: assetB, targetAsset: assetA }
      : { sourceAsset: assetA, targetAsset: assetB };
  }

  const priceA = getAssetPriceUSD(assetA, priceIndex) ?? 0;
  const priceB = getAssetPriceUSD(assetB, priceIndex) ?? 0;

  if (priceA !== priceB) {
    return priceA >= priceB
      ? { sourceAsset: assetA, targetAsset: assetB }
      : { sourceAsset: assetB, targetAsset: assetA };
  }

  const normalizedA = normalizeAsset(assetA);
  const normalizedB = normalizeAsset(assetB);

  return normalizedA.localeCompare(normalizedB) <= 0
    ? { sourceAsset: assetA, targetAsset: assetB }
    : { sourceAsset: assetB, targetAsset: assetA };
}

function getMarketKey(sourceAsset, targetAsset) {
  return `${normalizeAsset(sourceAsset)}|${normalizeAsset(targetAsset)}`;
}

function getPairVariantKey(sourceAsset, targetAsset) {
  return `${sourceAsset}|${targetAsset}`;
}

function dedupePairVariants(pairs) {
  const seen = new Set();

  return (Array.isArray(pairs) ? pairs : []).filter((pair) => {
    const sourceAsset = pair?.sourceAsset ?? '';
    const targetAsset = pair?.targetAsset ?? '';
    if (!sourceAsset || !targetAsset) return false;

    const key = getPairVariantKey(sourceAsset, targetAsset);
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

function toTradeAsset(asset) {
  if (!asset || normalizeAsset(asset) === 'THOR.RUNE') return asset;
  if (asset.includes('~')) return asset;

  const dotIndex = asset.indexOf('.');
  if (dotIndex > 0) {
    return `${asset.slice(0, dotIndex)}~${asset.slice(dotIndex + 1)}`;
  }

  const dashIndex = asset.indexOf('-');
  if (dashIndex > 0) {
    return `${asset.slice(0, dashIndex)}~${asset.slice(dashIndex + 1)}`;
  }

  return asset;
}

function buildOpenOrderStats(summary, priceIndex) {
  const stats = new Map();

  if (!Array.isArray(summary?.asset_pairs)) return stats;

  for (const pair of summary.asset_pairs) {
    const sourceAsset = pair?.source_asset ?? '';
    const targetAsset = pair?.target_asset ?? '';
    if (!sourceAsset || !targetAsset || normalizeAsset(sourceAsset) === normalizeAsset(targetAsset)) continue;

    const oriented = orientMarketPair(sourceAsset, targetAsset, priceIndex);
    const key = getMarketKey(oriented.sourceAsset, oriented.targetAsset);
    const existing = stats.get(key) ?? { count: 0, openValueUsd: 0, queuePairs: [] };

    existing.count += Number(pair?.count ?? 0);
    existing.openValueUsd += fromBaseUnit(pair?.total_value_usd ?? 0);
    existing.queuePairs = dedupePairVariants([
      ...existing.queuePairs,
      {
        sourceAsset: oriented.sourceAsset,
        targetAsset: oriented.targetAsset
      }
    ]);

    stats.set(key, existing);
  }

  return stats;
}

function getAssetLiquidityUSD(asset, pool, priceIndex, runeLiquidityUsd) {
  if (normalizeAsset(asset) === 'THOR.RUNE') return runeLiquidityUsd;

  const assetPriceUsd = getAssetPriceUSD(asset, priceIndex) ?? 0;
  if (!(assetPriceUsd > 0)) return 0;

  return fromBaseUnit(pool?.balance_asset ?? 0) * assetPriceUsd;
}

function getAssetVolumeUSD(asset, pool, priceIndex, runeVolumeUsd) {
  if (normalizeAsset(asset) === 'THOR.RUNE') return runeVolumeUsd;

  const assetPriceUsd = getAssetPriceUSD(asset, priceIndex) ?? 0;
  if (!(assetPriceUsd > 0)) return 0;

  return fromBaseUnit(pool?.volume_asset ?? 0) * assetPriceUsd;
}

function isChainTradingEnabled(entry) {
  if (!entry?.chain) return false;
  if (entry.halted) return false;
  if (entry.global_trading_paused) return false;
  if (entry.chain_trading_paused) return false;
  return true;
}

function isTradablePool(pool, shouldFilterChains, supportedChains, priceIndex) {
  if (!pool?.asset) return false;
  if (pool.status !== 'Available' || pool.trading_halted) return false;

  const chain = getChainFromAsset(pool.asset);
  if (!chain) return false;
  if (shouldFilterChains && !supportedChains.has(chain)) return false;

  const assetPriceUsd = getAssetPriceUSD(pool.asset, priceIndex) ?? 0;
  return assetPriceUsd > 0;
}

/**
 * Build the full supported market list from tradable pools plus native RUNE.
 *
 * Markets are generated from every currently tradable asset combination, then
 * oriented onto a stable base/quote axis and enriched with live pricing plus
 * open-order counts from the limit-swap summary.
 *
 * @param {Array<Object>} pools - Pool response from THORNode
 * @param {Map<string, number>} priceIndex - From buildPoolPriceIndex
 * @param {Object|null} [summary] - Limit swap summary response from THORNode
 * @param {Array<Object>} [inboundAddresses=[]] - Inbound address status rows
 * @returns {Array<Object>} Sorted pair list with normalized names and USD values
 */
export function buildPairList(pools, priceIndex, summary = null, inboundAddresses = []) {
  const chainRows = Array.isArray(inboundAddresses) ? inboundAddresses : [];
  const shouldFilterChains = chainRows.length > 0;
  const supportedChains = new Set(['THOR']);

  for (const entry of chainRows) {
    if (isChainTradingEnabled(entry)) {
      supportedChains.add(entry.chain);
    }
  }

  const tradablePools = (Array.isArray(pools) ? pools : []).filter((pool) =>
    isTradablePool(pool, shouldFilterChains, supportedChains, priceIndex)
  );

  const runePriceUsd = getAssetPriceUSD('THOR.RUNE', priceIndex) ?? 0;
  const runeLiquidityUsd = tradablePools.reduce(
    (total, pool) => total + (fromBaseUnit(pool?.balance_rune ?? 0) * runePriceUsd),
    0
  );
  const runeVolumeUsd = tradablePools.reduce(
    (total, pool) => total + (fromBaseUnit(pool?.volume_rune ?? 0) * runePriceUsd),
    0
  );

  const assetEntries = tradablePools.map((pool) => ({
    asset: pool.asset,
    pool,
    normalizedAsset: normalizeAsset(pool.asset),
    type: getAssetType(pool.asset),
    chain: getChainFromAsset(pool.asset),
    priceUsd: getAssetPriceUSD(pool.asset, priceIndex) ?? 0
  }));

  if (runePriceUsd > 0) {
    assetEntries.push({
      asset: 'THOR.RUNE',
      pool: null,
      normalizedAsset: 'THOR.RUNE',
      type: 'native',
      chain: 'THOR',
      priceUsd: runePriceUsd
    });
  }

  const uniqueAssets = [];
  const seenAssets = new Set();

  for (const entry of assetEntries) {
    const key = entry.normalizedAsset;
    if (!key || seenAssets.has(key)) continue;
    seenAssets.add(key);
    uniqueAssets.push(entry);
  }

  const orderStats = buildOpenOrderStats(summary, priceIndex);
  const pairs = [];

  for (let i = 0; i < uniqueAssets.length; i += 1) {
    for (let j = i + 1; j < uniqueAssets.length; j += 1) {
      const left = uniqueAssets[i];
      const right = uniqueAssets[j];
      const oriented = orientMarketPair(left.asset, right.asset, priceIndex);

      const sourceEntry = oriented.sourceAsset === left.asset ? left : right;
      const targetEntry = oriented.targetAsset === right.asset ? right : left;

      const sourcePriceUsd = sourceEntry.priceUsd;
      const targetPriceUsd = targetEntry.priceUsd;
      const marketPrice = targetPriceUsd > 0 ? sourcePriceUsd / targetPriceUsd : null;

      if (!(marketPrice > 0)) continue;

      const key = getMarketKey(sourceEntry.asset, targetEntry.asset);
      const stats = orderStats.get(key) ?? { count: 0, openValueUsd: 0, queuePairs: [] };
      const preferredLimitPair = {
        sourceAsset: toTradeAsset(sourceEntry.asset),
        targetAsset: toTradeAsset(targetEntry.asset)
      };
      const queuePairs = dedupePairVariants([
        ...stats.queuePairs,
        preferredLimitPair
      ]);
      const historyAssets = dedupeAssets([
        sourceEntry.asset,
        targetEntry.asset,
        preferredLimitPair.sourceAsset,
        preferredLimitPair.targetAsset,
        ...queuePairs.flatMap((pair) => [pair.sourceAsset, pair.targetAsset])
      ]);

      const sourceLiquidityUsd = getAssetLiquidityUSD(sourceEntry.asset, sourceEntry.pool, priceIndex, runeLiquidityUsd);
      const targetLiquidityUsd = getAssetLiquidityUSD(targetEntry.asset, targetEntry.pool, priceIndex, runeLiquidityUsd);
      const sourceVolumeUsd = getAssetVolumeUSD(sourceEntry.asset, sourceEntry.pool, priceIndex, runeVolumeUsd);
      const targetVolumeUsd = getAssetVolumeUSD(targetEntry.asset, targetEntry.pool, priceIndex, runeVolumeUsd);

      const sourceSymbol = getAssetTicker(sourceEntry.asset);
      const targetSymbol = getAssetTicker(targetEntry.asset);

      pairs.push({
        sourceAsset: sourceEntry.asset,
        targetAsset: targetEntry.asset,
        limitSourceAsset: preferredLimitPair.sourceAsset,
        limitTargetAsset: preferredLimitPair.targetAsset,
        queuePairs,
        historyAssets,
        sourceNormalized: sourceEntry.normalizedAsset,
        targetNormalized: targetEntry.normalizedAsset,
        sourceType: sourceEntry.type,
        targetType: targetEntry.type,
        sourceChain: sourceEntry.chain,
        targetChain: targetEntry.chain,
        sourcePriceUsd,
        targetPriceUsd,
        marketPrice,
        liquidityUsd: Math.min(sourceLiquidityUsd, targetLiquidityUsd),
        volumeUsd: sourceVolumeUsd + targetVolumeUsd,
        count: stats.count,
        openValueUsd: stats.openValueUsd,
        searchText: [
          sourceEntry.normalizedAsset,
          targetEntry.normalizedAsset,
          sourceEntry.chain,
          targetEntry.chain,
          sourceSymbol,
          targetSymbol,
          `${sourceSymbol}/${targetSymbol}`,
          `${targetSymbol}/${sourceSymbol}`
        ].join(' ').toLowerCase()
      });
    }
  }

  return pairs.sort((left, right) => {
    if (right.liquidityUsd !== left.liquidityUsd) return right.liquidityUsd - left.liquidityUsd;
    if (right.volumeUsd !== left.volumeUsd) return right.volumeUsd - left.volumeUsd;
    if (right.count !== left.count) return right.count - left.count;
    return left.searchText.localeCompare(right.searchText);
  });
}

/**
 * Build a cancel (or modify) memo for an existing limit swap.
 *
 * To cancel an order, set the target amount to 0.
 * Format: `m=<:sourceAmountSourceAsset:targetAmountTargetAsset:0`
 *
 * @param {string|number} sourceAmount - Source amount in base units
 * @param {string} sourceAsset     - Source asset identifier
 * @param {string|number} targetAmount - Current target amount in base units
 * @param {string} targetAsset     - Target asset identifier
 * @returns {string} Cancel memo
 */
export function createCancelMemo(sourceAmount, sourceAsset, targetAmount, targetAsset) {
  return `m=<:${sourceAmount}${sourceAsset}:${targetAmount}${targetAsset}:0`;
}
