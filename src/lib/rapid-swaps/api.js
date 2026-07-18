import { thornode } from '../api/thornode.js';
import { booneToolsApi } from '../api/boonetools.js';
import {
  buildAssetUsdIndex,
  estimateCoinUsd
} from './model.js';

function getConfigError() {
  // The canonical client defaults to the same-origin public `/functions/v1`
  // route. An explicit base and browser-visible client token are both optional.
  return '';
}

function roundUsd(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * 100) / 100;
}

export function getRapidSwapsApiConfigError() {
  return getConfigError();
}

export async function fetchRapidSwapsDashboard(options = {}) {
  const configError = getConfigError();
  if (configError) {
    throw new Error(configError);
  }

  return booneToolsApi.get('/rapid-swaps', {
    forceRefresh: options.forceRefresh,
    query: options.params,
    errorMessage: ({ response }) => `Rapid swaps backend request failed (${response.status})`,
    challengeMessage: 'Rapid swaps backend returned challenge response'
  });
}

export async function fetchRapidSwapsSwapHistory(params = {}) {
  const configError = getConfigError();
  if (configError) {
    throw new Error(configError);
  }

  return booneToolsApi.get('/rapid-swaps-swap-history', {
    query: params,
    errorMessage: ({ response }) => `Rapid swaps history request failed (${response.status})`,
    challengeMessage: 'Rapid swaps history backend returned challenge response'
  });
}

export async function fetchLiveRapidSwaps() {
  const [network, pools, streamingSwaps] = await Promise.all([
    thornode.getNetwork(),
    thornode.getPools(),
    thornode.fetch('/thorchain/swaps/streaming', { cache: false })
  ]);

  const priceIndex = buildAssetUsdIndex(network, pools);

  return (Array.isArray(streamingSwaps) ? streamingSwaps : [])
    .filter((swap) => Number(swap?.interval) === 0 && Number(swap?.quantity) > 1)
    .map((swap) => {
      const inputCoin = {
        asset: swap?.source_asset || '',
        amount: swap?.deposit || '0'
      };
      const outputCoin = {
        asset: swap?.target_asset || '',
        amount: swap?.out || '0'
      };

      return {
        tx_id: String(swap?.tx_id || ''),
        source_asset: String(swap?.source_asset || ''),
        target_asset: String(swap?.target_asset || ''),
        input_amount_base: String(swap?.deposit || '0'),
        output_amount_base: String(swap?.out || '0'),
        input_estimated_usd: roundUsd(estimateCoinUsd(inputCoin, priceIndex)),
        output_estimated_usd: roundUsd(estimateCoinUsd(outputCoin, priceIndex)),
        streaming_interval: Number(swap?.interval) || 0,
        streaming_quantity: Number(swap?.quantity) || 0,
        streaming_count: Number(swap?.count) || 0,
        destination_address: String(swap?.destination || ''),
        last_height: Number(swap?.last_height) || 0
      };
    })
    .sort((left, right) => {
      const usdDiff = (right.input_estimated_usd || 0) - (left.input_estimated_usd || 0);
      if (usdDiff !== 0) {
        return usdDiff;
      }

      return (right.last_height || 0) - (left.last_height || 0);
    });
}
