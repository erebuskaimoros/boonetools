import { normalizeAsset } from '../blockchain.js';

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundUsd(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * 100) / 100;
}

export const RAPID_SWAP_VOLUME_BASIS = 'executed-leg-usd';

export function getRapidSwapLegVolumeUsd(row) {
  const cachedLegVolume = Number(row?.leg_volume_usd);
  if (Number.isFinite(cachedLegVolume)) {
    return roundUsd(cachedLegVolume);
  }

  const cachedVolume = Number(row?.comparable_volume_usd);
  if (Number.isFinite(cachedVolume)) {
    return roundUsd(cachedVolume);
  }

  const inputUsd = safeNumber(row?.input_estimated_usd, 0);
  const outputUsd = safeNumber(row?.output_estimated_usd, 0);
  const sourceAsset = normalizeAsset(String(row?.source_asset || ''));
  const targetAsset = normalizeAsset(String(row?.target_asset || ''));

  if (sourceAsset === 'THOR.RUNE' || targetAsset === 'THOR.RUNE') {
    return roundUsd(inputUsd || outputUsd);
  }

  if (inputUsd > 0 && outputUsd > 0) {
    return roundUsd(inputUsd + outputUsd);
  }

  return roundUsd(inputUsd || outputUsd);
}

// Compatibility alias for the persisted column's historical name.
export function getRapidSwapComparableVolumeUsd(row) {
  return getRapidSwapLegVolumeUsd(row);
}

export function getRapidSwapRouteVolumeUsd(row) {
  const cachedRouteVolume = Number(row?.route_volume_usd);
  if (Number.isFinite(cachedRouteVolume)) {
    return roundUsd(cachedRouteVolume);
  }

  const inputUsd = safeNumber(row?.input_estimated_usd, 0);
  const outputUsd = safeNumber(row?.output_estimated_usd, 0);
  return roundUsd(inputUsd || outputUsd);
}

export function sumRapidSwapLegVolumeUsd(rows) {
  return roundUsd(
    (Array.isArray(rows) ? rows : []).reduce(
      (sum, row) => sum + getRapidSwapLegVolumeUsd(row),
      0
    )
  );
}

export function sumRapidSwapComparableVolumeUsd(rows) {
  return sumRapidSwapLegVolumeUsd(rows);
}
