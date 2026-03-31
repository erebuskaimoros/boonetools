import { thornode } from '../api/thornode.js';
import {
  buildAssetUsdIndex,
  estimateCoinUsd
} from './model.js';

const RAPID_SWAPS_API = {
  base: (import.meta.env.VITE_RAPID_SWAPS_API_BASE || import.meta.env.VITE_NODEOP_API_BASE || '').replace(/\/$/, ''),
  key: import.meta.env.VITE_RAPID_SWAPS_API_KEY || import.meta.env.VITE_NODEOP_API_KEY || ''
};

function getConfigError() {
  if (!RAPID_SWAPS_API.base && !RAPID_SWAPS_API.key) {
    return 'Rapid swap recorder backend is not configured. Set VITE_RAPID_SWAPS_API_BASE/VITE_RAPID_SWAPS_API_KEY or reuse the Node Operator backend env vars.';
  }

  if (!RAPID_SWAPS_API.base) {
    return 'Rapid swap recorder backend is not configured. Missing VITE_RAPID_SWAPS_API_BASE.';
  }

  if (!RAPID_SWAPS_API.key) {
    return 'Rapid swap recorder backend is not configured. Missing VITE_RAPID_SWAPS_API_KEY.';
  }

  return '';
}

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
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

  const params = new URLSearchParams();
  if (options.forceRefresh) {
    params.set('ts', String(Date.now()));
  }

  const url = `${RAPID_SWAPS_API.base}/rapid-swaps${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      apikey: RAPID_SWAPS_API.key,
      Authorization: `Bearer ${RAPID_SWAPS_API.key}`
    }
  });

  if (!response.ok) {
    let message = `Rapid swaps backend request failed (${response.status})`;

    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch (_) {
      // Ignore JSON parse issues for error payloads.
    }

    throw new Error(message);
  }

  if (isChallengeResponse(response)) {
    throw new Error('Rapid swaps backend returned challenge response');
  }

  return response.json();
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
