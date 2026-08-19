export const POL_TRACKER_SCHEMA_VERSION = 2;
export const POL_TRACKER_START_DATE = '2025-02-01';
export const POL_TRACKER_TREASURY_MODULE = 'thor1vmafl8f3s6uuzwnxkqz0eza47v6ecn0t086r2p';
export const POL_TRACKER_RESERVE_MODULE = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt';

const E8 = 100_000_000n;

function integer(value) {
  if (typeof value === 'bigint') return value;
  const normalized = String(value ?? '').trim();
  if (!/^-?\d+$/.test(normalized)) return 0n;
  return BigInt(normalized);
}

function positive(value) {
  const parsed = integer(value);
  return parsed > 0n ? parsed : 0n;
}

function e8Product(amount, price) {
  return (positive(amount) * positive(price)) / E8;
}

// Mirrors THORNode common.GetSafeShare: cap the ownership ratio and round the
// final positive integer division half up.
function safeShare(part, total, allocation) {
  const denominator = positive(total);
  const depth = positive(allocation);
  let units = positive(part);
  if (units === 0n || denominator === 0n || depth === 0n) return 0n;
  if (units >= denominator) return depth;
  return ((depth * units) + (denominator / 2n)) / denominator;
}

function synthBackingValue(pool) {
  const synthUnits = positive(pool?.synth_units);
  const poolUnits = positive(pool?.pool_units);
  if (synthUnits === 0n || poolUnits === 0n) return 0n;
  return (2n * positive(pool?.balance_asset) * positive(pool?.asset_tor_price) * synthUnits)
    / (E8 * poolUnits);
}

function lane(status, warning = '') {
  return { status, ...(warning ? { warning } : {}) };
}

function normalizedAsset(value) {
  return String(value || '').trim().toUpperCase();
}

function lpForAsset(positions, asset) {
  if (positions instanceof Map) return positions.get(asset) || null;
  return positions?.[asset] || null;
}

function totalOrNull(values, complete) {
  if (!complete) return null;
  return values.reduce((total, value) => total + positive(value), 0n).toString();
}

/**
 * Build one same-height POL Tracker observation. All returned monetary values
 * remain integer e8 strings until the public read model is assembled.
 */
export function buildPolTrackerObservation(input = {}) {
  const pools = (Array.isArray(input.pools) ? input.pools : [])
    .filter((pool) => normalizedAsset(pool?.asset) && !normalizedAsset(pool?.asset).startsWith('THOR.'));
  const runePrice = positive(input.network?.rune_price_in_tor);
  if (!runePrice) throw new Error('Historical network state did not include a RUNE/USD price');

  const treasuryErrors = Array.isArray(input.treasuryErrors) ? input.treasuryErrors : [];
  const treasuryErrorAssets = new Set(treasuryErrors.map((entry) => normalizedAsset(entry?.asset)));
  const reserveErrors = Array.isArray(input.reserveErrors) ? input.reserveErrors : [];
  const reserveErrorAssets = new Set(reserveErrors.map((entry) => normalizedAsset(entry?.asset)));
  let synthComplete = true;
  let treasuryAssetComplete = treasuryErrors.length === 0;
  let treasuryRuneComplete = treasuryErrors.length === 0;

  const poolRows = pools.map((pool) => {
    const asset = normalizedAsset(pool.asset);
    const price = positive(pool.asset_tor_price);
    const synthUnits = positive(pool.synth_units);
    const lp = lpForAsset(input.treasuryLps, asset);
    const treasuryLookupComplete = !treasuryErrorAssets.has(asset);
    const treasuryUnits = positive(lp?.units);
    const assetRedeem = positive(lp?.asset_redeem_value);
    const runeRedeem = positive(lp?.rune_redeem_value);
    const reserveLp = lpForAsset(input.reserveLps, asset);
    const reserveLookupComplete = !reserveErrorAssets.has(asset);
    const reserveLpUnits = positive(reserveLp?.units);
    // runepool.pol.value doubles THORNode's rounded safe share of RUNE depth,
    // representing the gross value of the Reserve's symmetric LP position.
    const reservePolRune = reserveLookupComplete
      ? 2n * safeShare(reserveLpUnits, pool.pool_units, pool.balance_rune)
      : null;
    const reservePolUsd = reservePolRune === null ? null : e8Product(reservePolRune, runePrice);

    if (synthUnits > 0n && (price === 0n || positive(pool.pool_units) === 0n)) synthComplete = false;
    if ((treasuryUnits > 0n || assetRedeem > 0n) && price === 0n) treasuryAssetComplete = false;

    const synthBackingUsd = price > 0n && (synthUnits === 0n || positive(pool.pool_units) > 0n)
      ? synthBackingValue(pool)
      : null;
    const synthFaceUsd = price > 0n ? e8Product(pool.synth_supply, price) : null;
    const treasuryAssetUsd = treasuryLookupComplete && price > 0n
      ? e8Product(assetRedeem, price)
      : null;
    const treasuryRuneUsd = treasuryLookupComplete ? e8Product(runeRedeem, runePrice) : null;

    return {
      day: input.day,
      asset,
      pool_status: String(pool.status || ''),
      asset_price_usd_e8: price.toString(),
      balance_asset_e8: positive(pool.balance_asset).toString(),
      balance_rune_e8: positive(pool.balance_rune).toString(),
      pool_units: positive(pool.pool_units).toString(),
      lp_units: positive(pool.LP_units).toString(),
      synth_units: synthUnits.toString(),
      synth_supply_e8: positive(pool.synth_supply).toString(),
      synth_backing_usd_e8: synthBackingUsd?.toString() ?? null,
      synth_face_usd_e8: synthFaceUsd?.toString() ?? null,
      treasury_lp_units: treasuryLookupComplete ? treasuryUnits.toString() : null,
      treasury_asset_redeem_e8: treasuryLookupComplete ? assetRedeem.toString() : null,
      treasury_rune_redeem_e8: treasuryLookupComplete ? runeRedeem.toString() : null,
      treasury_asset_usd_e8: treasuryAssetUsd?.toString() ?? null,
      treasury_rune_usd_e8: treasuryRuneUsd?.toString() ?? null,
      treasury_total_usd_e8: treasuryAssetUsd === null || treasuryRuneUsd === null
        ? null
        : (treasuryAssetUsd + treasuryRuneUsd).toString(),
      reserve_pol_lp_units: reserveLookupComplete ? reserveLpUnits.toString() : null,
      reserve_pol_rune_e8: reservePolRune?.toString() ?? null,
      reserve_pol_usd_e8: reservePolUsd?.toString() ?? null
    };
  });

  const runepoolAvailable = input.runepool && !input.runepoolError;
  const reservePolRune = runepoolAvailable ? positive(input.runepool?.pol?.value) : null;
  // Kept only in durable storage for reconciliation. It is deliberately not
  // emitted by the public read-model builder.
  const providerValue = input.runepool?.providers?.value;
  const providerOwnedRune = runepoolAvailable && /^\d+$/.test(String(providerValue ?? ''))
    ? positive(providerValue)
    : null;
  const perPoolReservePolRune = totalOrNull(
    poolRows.map((row) => row.reserve_pol_rune_e8),
    reserveErrors.length === 0
  );
  const reserveReconciles = runepoolAvailable
    && perPoolReservePolRune !== null
    && integer(perPoolReservePolRune) === reservePolRune;

  const treasuryComplete = treasuryAssetComplete && treasuryRuneComplete;
  const treasuryWarning = treasuryComplete
    ? ''
    : treasuryErrors.length
      ? `${treasuryErrors.length} Treasury LP lookup(s) were incomplete`
      : 'One or more Treasury positions lacked a same-height asset price';
  const reserveStatus = !runepoolAvailable
    ? 'unavailable'
    : reserveErrors.length > 0 || !reserveReconciles
      ? 'partial'
      : 'complete';
  const reserveWarning = !runepoolAvailable
    ? input.runepoolError || 'Historical RUNEPool response was unavailable'
    : reserveErrors.length > 0
      ? `${reserveErrors.length} Reserve POL LP lookup(s) were incomplete`
      : !reserveReconciles
        ? 'Per-pool Reserve POL did not reconcile to runepool.pol.value'
        : '';
  const laneStatus = {
    synth: lane(synthComplete ? 'complete' : 'partial', synthComplete ? '' : 'One or more synth pools lacked same-height units or price data'),
    treasury: lane(treasuryComplete ? 'complete' : 'partial', treasuryWarning),
    reserve_pol: lane(reserveStatus, reserveWarning)
  };
  const complete = Object.values(laneStatus).every(({ status }) => status === 'complete');
  const warnings = Object.values(laneStatus).map((item) => item.warning).filter(Boolean);

  return {
    daily: {
      day: input.day,
      anchor_height: Number(input.anchor?.height) || 0,
      anchor_block_time: input.anchor?.blockTime || null,
      treasury_module_address: input.moduleAddress || POL_TRACKER_TREASURY_MODULE,
      reserve_module_address: input.reserveModuleAddress || POL_TRACKER_RESERVE_MODULE,
      rune_price_usd_e8: runePrice.toString(),
      synth_backing_usd_e8: totalOrNull(poolRows.map((row) => row.synth_backing_usd_e8), synthComplete),
      synth_face_usd_e8: totalOrNull(poolRows.map((row) => row.synth_face_usd_e8), synthComplete),
      treasury_asset_usd_e8: totalOrNull(poolRows.map((row) => row.treasury_asset_usd_e8), treasuryAssetComplete),
      treasury_rune_usd_e8: totalOrNull(poolRows.map((row) => row.treasury_rune_usd_e8), treasuryRuneComplete),
      treasury_total_usd_e8: totalOrNull(poolRows.map((row) => row.treasury_total_usd_e8), treasuryComplete),
      reserve_pol_rune_e8: reservePolRune?.toString() ?? null,
      reserve_pol_usd_e8: reservePolRune === null ? null : e8Product(reservePolRune, runePrice).toString(),
      runepool_provider_owned_rune_e8: providerOwnedRune?.toString() ?? null,
      pool_count: poolRows.length,
      treasury_pool_count: poolRows.filter((row) => positive(row.treasury_lp_units) > 0n).length,
      reserve_pool_count: poolRows.filter((row) => positive(row.reserve_pol_lp_units) > 0n).length,
      complete,
      lane_status: laneStatus,
      warnings,
      source: 'thornode-same-height'
    },
    pools: poolRows
  };
}

export function e8ToNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value) / 1e8;
  return Number.isFinite(numeric) ? numeric : null;
}
