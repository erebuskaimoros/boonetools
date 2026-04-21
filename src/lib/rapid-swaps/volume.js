import { normalizeAsset } from '../utils/blockchain.js';

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

export function getRapidSwapComparableVolumeUsd(row) {
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

export function sumRapidSwapComparableVolumeUsd(rows) {
  return roundUsd(
    (Array.isArray(rows) ? rows : []).reduce(
      (sum, row) => sum + getRapidSwapComparableVolumeUsd(row),
      0
    )
  );
}
