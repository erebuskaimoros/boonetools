import { fromBaseUnit, normalizeAsset } from '../utils/blockchain.js';
import { getRapidSwapComparableVolumeUsd } from './volume.js';

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeString(value) {
  return String(value || '').trim();
}

function toIsoOrEmpty(value) {
  const millis = midgardTimestampToMillis(value);
  if (!millis) return '';

  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function midgardTimestampToMillis(value) {
  if (typeof value === 'string' && value.includes('T')) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric > 1e15) {
    return Math.trunc(numeric / 1e6);
  }

  if (numeric > 1e12) {
    return Math.trunc(numeric);
  }

  return Math.trunc(numeric * 1000);
}

export function parseStreamingParamsFromMemo(memo) {
  const segments = String(memo || '').split(':');
  if (segments.length < 4) {
    return {
      limit: '',
      interval: null,
      quantity: null,
      hasStreamingParams: false
    };
  }

  const streamingSegment = String(segments[3] || '');
  const parts = streamingSegment.split('/');

  if (parts.length < 3) {
    return {
      limit: streamingSegment,
      interval: null,
      quantity: null,
      hasStreamingParams: false
    };
  }

  const interval = Number(parts[1]);
  const quantity = Number(parts[2]);

  return {
    limit: parts[0] || '',
    interval: Number.isFinite(interval) ? interval : null,
    quantity: Number.isFinite(quantity) ? quantity : null,
    hasStreamingParams: Number.isFinite(interval) && Number.isFinite(quantity)
  };
}

export function getRapidSwapStreamingDetails(action) {
  const streamingMeta = action?.metadata?.swap?.streamingSwapMeta || null;
  const memoDetails = parseStreamingParamsFromMemo(action?.metadata?.swap?.memo || '');

  const interval = streamingMeta?.interval ?? memoDetails.interval;
  const quantity = streamingMeta?.quantity ?? memoDetails.quantity;
  const count = streamingMeta?.count ?? 0;

  return {
    interval: safeNumber(interval, Number.isFinite(Number(memoDetails.interval)) ? Number(memoDetails.interval) : 0),
    quantity: safeNumber(quantity, Number.isFinite(Number(memoDetails.quantity)) ? Number(memoDetails.quantity) : 0),
    count: safeNumber(count, 0)
  };
}

export function isRapidSwapAction(action) {
  if (!action?.metadata?.swap) {
    return false;
  }

  if (action?.status !== 'success') {
    return false;
  }

  const details = getRapidSwapStreamingDetails(action);
  if (details.interval !== 0 || details.quantity <= 1) {
    return false;
  }

  // Rapid swaps must execute multiple subs per block. If subs <= blocks,
  // it's functionally an interval=1 streaming swap.
  const blocksUsed = computeBlocksUsed(action);
  if (blocksUsed > 0 && details.count <= blocksUsed) {
    return false;
  }

  return true;
}

function pickPrimaryCoin(legs, options = {}) {
  const skipAffiliate = Boolean(options.skipAffiliate);
  const source = Array.isArray(legs) ? legs : [];

  for (const leg of source) {
    if (skipAffiliate && leg?.affiliate) {
      continue;
    }

    if (Array.isArray(leg?.coins) && leg.coins[0]) {
      return leg.coins[0];
    }
  }

  return null;
}

export function getRapidSwapTxId(action) {
  return String(action?.in?.[0]?.txID || action?.txID || '');
}

export function getRapidSwapInputCoin(action) {
  return (
    pickPrimaryCoin(action?.in) ||
    action?.metadata?.swap?.streamingSwapMeta?.inCoin ||
    action?.metadata?.swap?.streamingSwapMeta?.depositedCoin ||
    null
  );
}

const MEMO_CHAIN_MAP = {
  'b': 'BTC.BTC', 'BTC': 'BTC.BTC',
  'e': 'ETH.ETH', 'ETH': 'ETH.ETH',
  'r': 'THOR.RUNE', 'THOR': 'THOR.RUNE',
  'g': 'GAIA.ATOM', 'GAIA': 'GAIA.ATOM',
  'd': 'DOGE.DOGE', 'DOGE': 'DOGE.DOGE',
  'l': 'LTC.LTC', 'LTC': 'LTC.LTC',
  's': 'BSC.BNB', 'BSC': 'BSC.BNB',
  'c': 'BCH.BCH', 'BCH': 'BCH.BCH',
  'a': 'AVAX.AVAX', 'AVAX': 'AVAX.AVAX',
  'n': 'BASE.ETH', 'BASE': 'BASE.ETH',
  'j': 'XRP.XRP', 'XRP': 'XRP.XRP',
  't': 'TRON.TRX', 'TRON': 'TRON.TRX',
  'o': 'SOL.SOL', 'SOL': 'SOL.SOL'
};

function targetAssetFromMemo(memo) {
  const parts = String(memo || '').split(':');
  if (parts.length < 2) return '';
  const target = parts[1];
  // If it contains a dot or dash, it's a full asset identifier (e.g. ETH.USDC-0x...)
  if (target.includes('.') || target.includes('-')) return target;
  // Otherwise it's a shorthand chain identifier
  return MEMO_CHAIN_MAP[target] || '';
}

export function getRapidSwapOutputCoin(action) {
  return (
    pickPrimaryCoin(action?.out, { skipAffiliate: true }) ||
    action?.metadata?.swap?.streamingSwapMeta?.outCoin ||
    null
  );
}

export function parseRapidSwapCoinString(value) {
  const text = safeString(value);
  if (!text) {
    return null;
  }

  const firstSpace = text.indexOf(' ');
  if (firstSpace <= 0 || firstSpace >= text.length - 1) {
    return null;
  }

  return {
    amount: text.slice(0, firstSpace).trim(),
    asset: text.slice(firstSpace + 1).trim()
  };
}

export function getRapidSwapDestinationAddressFromMemo(memo) {
  const parts = String(memo || '').split(':');
  return safeString(parts[2]);
}

function setAssetPrice(prices, asset, usdPrice) {
  if (!asset || !Number.isFinite(usdPrice) || usdPrice <= 0) {
    return;
  }

  prices.set(asset, usdPrice);
  prices.set(normalizeAsset(asset), usdPrice);
}

export function buildAssetUsdIndex(network = {}, pools = []) {
  const prices = new Map();
  const runePriceUsd = fromBaseUnit(network?.rune_price_in_tor || 0);

  if (runePriceUsd > 0) {
    setAssetPrice(prices, 'THOR.RUNE', runePriceUsd);
  }

  for (const pool of Array.isArray(pools) ? pools : []) {
    const asset = String(pool?.asset || '');
    const usdPrice = fromBaseUnit(pool?.asset_tor_price || 0);
    setAssetPrice(prices, asset, usdPrice);
  }

  return {
    prices,
    runePriceUsd
  };
}

export function lookupAssetUsd(asset, priceIndex) {
  const prices = priceIndex?.prices instanceof Map
    ? priceIndex.prices
    : priceIndex instanceof Map
      ? priceIndex
      : new Map();

  if (!asset) {
    return 0;
  }

  if (prices.has(asset)) {
    return safeNumber(prices.get(asset), 0);
  }

  const normalized = normalizeAsset(asset);
  if (prices.has(normalized)) {
    return safeNumber(prices.get(normalized), 0);
  }

  if (normalized === 'THOR.RUNE') {
    return safeNumber(priceIndex?.runePriceUsd, 0);
  }

  // Trade account assets use CHAIN-ASSET format (dash instead of dot)
  if (!asset.includes('.') && asset.includes('-')) {
    const dotVersion = asset.replace('-', '.');
    if (prices.has(dotVersion)) {
      return safeNumber(prices.get(dotVersion), 0);
    }
    const normalizedDot = normalizeAsset(dotVersion);
    if (prices.has(normalizedDot)) {
      return safeNumber(prices.get(normalizedDot), 0);
    }
  }

  return 0;
}

export function estimateCoinUsd(coin, priceIndex) {
  if (!coin?.asset) {
    return 0;
  }

  const amount = fromBaseUnit(coin.amount || 0);
  const priceUsd = lookupAssetUsd(coin.asset, priceIndex);
  return amount * priceUsd;
}

function roundUsd(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * 100) / 100;
}

function computeBlocksUsed(action) {
  const startHeight = Number(action?.height) || 0;
  const lastHeight = Number(action?.metadata?.swap?.streamingSwapMeta?.lastHeight) || 0;
  if (startHeight > 0 && lastHeight >= startHeight) {
    return lastHeight - startHeight + 1;
  }
  const outHeight = Number(action?.out?.[0]?.height) || 0;
  if (startHeight > 0 && outHeight >= startHeight) {
    return outHeight - startHeight + 1;
  }
  return 0;
}

function getObservedTxPrimaryCoin(observedTx) {
  const coin = Array.isArray(observedTx?.observed_tx?.tx?.coins)
    ? observedTx.observed_tx.tx.coins[0]
    : null;

  if (!coin?.asset || coin?.amount == null) {
    return null;
  }

  return {
    asset: String(coin.asset),
    amount: String(coin.amount)
  };
}

export function buildRapidSwapSyntheticAction(hintInput = {}, observedTx = {}, options = {}) {
  const tx = observedTx?.observed_tx?.tx || {};
  const memo = safeString(tx.memo || hintInput.memo);
  const txId = safeString(tx.id || hintInput.tx_id);
  if (!memo || !txId) {
    return null;
  }

  const rawHint = hintInput?.raw_hint && typeof hintInput.raw_hint === 'object'
    ? hintInput.raw_hint
    : {};
  const interval = safeNumber(rawHint.interval ?? hintInput.interval, 0);
  const quantity = safeNumber(rawHint.quantity ?? hintInput.quantity, 0);
  const count = safeNumber(rawHint.count ?? hintInput.count, 0);
  const actionHeight = Math.max(
    0,
    Math.trunc(safeNumber(observedTx?.consensus_height, safeNumber(hintInput.action_height, 0)))
  );
  const lastHeight = Math.max(
    actionHeight,
    Math.trunc(
      safeNumber(
        hintInput.last_height,
        safeNumber(rawHint.last_height, safeNumber(observedTx?.finalised_height, actionHeight))
      )
    )
  );
  const sourceAddress = safeString(tx.from_address || hintInput.source_address);
  const destinationAddress = getRapidSwapDestinationAddressFromMemo(memo);
  const depositedCoin = parseRapidSwapCoinString(hintInput.deposit) || getObservedTxPrimaryCoin(observedTx);
  const inputCoin = parseRapidSwapCoinString(hintInput.in) || depositedCoin || getObservedTxPrimaryCoin(observedTx);
  const outputCoin = parseRapidSwapCoinString(hintInput.out);
  const observedAt = options.observedAt || new Date().toISOString();

  return {
    date: observedAt,
    height: String(actionHeight || lastHeight || 0),
    status: 'success',
    txType: 'swap',
    in: [
      {
        address: sourceAddress,
        txID: txId,
        coins: inputCoin ? [inputCoin] : []
      }
    ],
    out: outputCoin
      ? [
          {
            address: destinationAddress,
            coins: [outputCoin],
            height: String(lastHeight || actionHeight || 0)
          }
        ]
      : [],
    metadata: {
      swap: {
        memo,
        liquidityFee: '0',
        swapSlip: '0',
        affiliateAddress: '',
        txType: 'swap',
        streamingSwapMeta: {
          interval: String(interval),
          quantity: String(quantity),
          count: String(count),
          lastHeight: String(lastHeight || 0),
          depositedCoin,
          inCoin: inputCoin,
          outCoin: outputCoin
        }
      }
    }
  };
}

export function normalizeRapidSwapHintAction(hintInput = {}, observedTx = {}, options = {}) {
  const syntheticAction = buildRapidSwapSyntheticAction(hintInput, observedTx, options);
  if (!syntheticAction) {
    return null;
  }

  return normalizeRapidSwapAction(syntheticAction, options);
}

export function normalizeRapidSwapAction(action, options = {}) {
  if (!isRapidSwapAction(action)) {
    return null;
  }

  const inputCoin = getRapidSwapInputCoin(action);
  const outputCoin = getRapidSwapOutputCoin(action);
  const streaming = getRapidSwapStreamingDetails(action);
  const observedAt = options.observedAt || new Date().toISOString();
  const actionDate = toIsoOrEmpty(action?.date) || observedAt;
  const sourceAsset = String(inputCoin?.asset || '');
  const targetAsset = String(outputCoin?.asset || '') || targetAssetFromMemo(action?.metadata?.swap?.memo);
  const inputEstimatedUsd = roundUsd(estimateCoinUsd(inputCoin, options.priceIndex));
  const outputEstimatedUsd = roundUsd(estimateCoinUsd(outputCoin, options.priceIndex));
  const primaryOutLeg = Array.isArray(action?.out)
    ? action.out.find((leg) => !leg?.affiliate && Array.isArray(leg?.coins) && leg.coins[0])
    : null;

  return {
    tx_id: getRapidSwapTxId(action),
    action_height: safeNumber(action?.height, 0),
    action_date: actionDate,
    observed_at: observedAt,
    memo: String(action?.metadata?.swap?.memo || ''),
    status: 'completed',
    tx_status: String(action?.status || ''),
    source_asset: sourceAsset,
    target_asset: targetAsset,
    input_amount_base: String(inputCoin?.amount || '0'),
    output_amount_base: String(outputCoin?.amount || '0'),
    input_estimated_usd: inputEstimatedUsd,
    output_estimated_usd: outputEstimatedUsd,
    comparable_volume_usd: getRapidSwapComparableVolumeUsd({
      source_asset: sourceAsset,
      target_asset: targetAsset,
      input_estimated_usd: inputEstimatedUsd,
      output_estimated_usd: outputEstimatedUsd
    }),
    liquidity_fee_base: String(action?.metadata?.swap?.liquidityFee || '0'),
    swap_slip_bps: safeNumber(action?.metadata?.swap?.swapSlip, 0),
    is_limit_order: String(action?.metadata?.swap?.memo || '').startsWith('=<') || action?.txType === 'limitOrder',
    streaming_interval: streaming.interval,
    streaming_quantity: streaming.quantity,
    streaming_count: streaming.count,
    blocks_used: computeBlocksUsed(action),
    affiliate: String(action?.metadata?.swap?.affiliateAddress || ''),
    source_address: String(action?.in?.[0]?.address || ''),
    destination_address: String(primaryOutLeg?.address || action?.out?.[0]?.address || ''),
    raw_action: action
  };
}

export function rankRapidSwapsByUsd(rows, limit = 20) {
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((left, right) => {
      const usdDiff = getRapidSwapComparableVolumeUsd(right) - getRapidSwapComparableVolumeUsd(left);
      if (usdDiff !== 0) {
        return usdDiff;
      }

      return midgardTimestampToMillis(right?.action_date) - midgardTimestampToMillis(left?.action_date);
    })
    .slice(0, Math.max(0, limit));
}

export function filterRapidSwapsSince(rows, sinceMs) {
  return [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => midgardTimestampToMillis(row?.action_date) >= sinceMs)
    .sort((left, right) => midgardTimestampToMillis(right?.action_date) - midgardTimestampToMillis(left?.action_date));
}
