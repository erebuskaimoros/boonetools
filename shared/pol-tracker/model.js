export const POL_TRACKER_SCHEMA_VERSION = 1;
export const POL_TRACKER_START_DATE = '2025-02-01';
export const POL_TRACKER_TREASURY_MODULE = 'thor1vmafl8f3s6uuzwnxkqz0eza47v6ecn0t086r2p';

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

function lpForAsset(treasuryLps, asset) {
  if (treasuryLps instanceof Map) return treasuryLps.get(asset) || null;
  return treasuryLps?.[asset] || null;
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
  let saversComplete = true;
  let synthComplete = true;
  let treasuryAssetComplete = treasuryErrors.length === 0;
  let treasuryRuneComplete = treasuryErrors.length === 0;

  const poolRows = pools.map((pool) => {
    const asset = normalizedAsset(pool.asset);
    const price = positive(pool.asset_tor_price);
    const saversDepth = positive(pool.savers_depth);
    const synthUnits = positive(pool.synth_units);
    const lp = lpForAsset(input.treasuryLps, asset);
    const treasuryLookupComplete = !treasuryErrorAssets.has(asset);
    const treasuryUnits = positive(lp?.units);
    const assetRedeem = positive(lp?.asset_redeem_value);
    const runeRedeem = positive(lp?.rune_redeem_value);

    if (saversDepth > 0n && price === 0n) saversComplete = false;
    if (synthUnits > 0n && (price === 0n || positive(pool.pool_units) === 0n)) synthComplete = false;
    if ((treasuryUnits > 0n || assetRedeem > 0n) && price === 0n) treasuryAssetComplete = false;

    const saversUsd = price > 0n ? e8Product(saversDepth, price) : null;
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
      savers_depth_e8: saversDepth.toString(),
      savers_units: positive(pool.savers_units).toString(),
      savers_usd_e8: saversUsd?.toString() ?? null,
      synth_backing_usd_e8: synthBackingUsd?.toString() ?? null,
      synth_face_usd_e8: synthFaceUsd?.toString() ?? null,
      treasury_lp_units: treasuryLookupComplete ? treasuryUnits.toString() : null,
      treasury_asset_redeem_e8: treasuryLookupComplete ? assetRedeem.toString() : null,
      treasury_rune_redeem_e8: treasuryLookupComplete ? runeRedeem.toString() : null,
      treasury_asset_usd_e8: treasuryAssetUsd?.toString() ?? null,
      treasury_rune_usd_e8: treasuryRuneUsd?.toString() ?? null,
      treasury_total_usd_e8: treasuryAssetUsd === null || treasuryRuneUsd === null
        ? null
        : (treasuryAssetUsd + treasuryRuneUsd).toString()
    };
  });

  const runepoolAvailable = input.runepool && !input.runepoolError;
  const reservePolRune = runepoolAvailable ? positive(input.runepool?.pol?.value) : null;
  const reserveOwnedRune = runepoolAvailable ? positive(input.runepool?.reserve?.value) : null;
  // Kept only in durable storage for reconciliation. It is deliberately not
  // emitted by the public read-model builder.
  const providerOwnedRune = runepoolAvailable ? positive(input.runepool?.providers?.value) : null;

  const treasuryComplete = treasuryAssetComplete && treasuryRuneComplete;
  const treasuryWarning = treasuryComplete
    ? ''
    : treasuryErrors.length
      ? `${treasuryErrors.length} Treasury LP lookup(s) were incomplete`
      : 'One or more Treasury asset legs lacked a same-height price';
  const laneStatus = {
    savers: lane(saversComplete ? 'complete' : 'partial', saversComplete ? '' : 'One or more Saver pools lacked a same-height price'),
    synth: lane(synthComplete ? 'complete' : 'partial', synthComplete ? '' : 'One or more synth pools lacked same-height units or price data'),
    treasury: lane(treasuryComplete ? 'complete' : 'partial', treasuryWarning),
    reserve_pol: lane(runepoolAvailable ? 'complete' : 'unavailable', input.runepoolError || ''),
    runepool_reserve: lane(runepoolAvailable ? 'complete' : 'unavailable', input.runepoolError || '')
  };
  const complete = Object.values(laneStatus).every(({ status }) => status === 'complete');
  const warnings = Object.values(laneStatus).map((item) => item.warning).filter(Boolean);

  return {
    daily: {
      day: input.day,
      anchor_height: Number(input.anchor?.height) || 0,
      anchor_block_time: input.anchor?.blockTime || null,
      treasury_module_address: input.moduleAddress || POL_TRACKER_TREASURY_MODULE,
      rune_price_usd_e8: runePrice.toString(),
      savers_usd_e8: totalOrNull(poolRows.map((row) => row.savers_usd_e8), saversComplete),
      synth_backing_usd_e8: totalOrNull(poolRows.map((row) => row.synth_backing_usd_e8), synthComplete),
      synth_face_usd_e8: totalOrNull(poolRows.map((row) => row.synth_face_usd_e8), synthComplete),
      treasury_asset_usd_e8: totalOrNull(poolRows.map((row) => row.treasury_asset_usd_e8), treasuryAssetComplete),
      treasury_rune_usd_e8: totalOrNull(poolRows.map((row) => row.treasury_rune_usd_e8), treasuryRuneComplete),
      treasury_total_usd_e8: totalOrNull(poolRows.map((row) => row.treasury_total_usd_e8), treasuryComplete),
      reserve_pol_rune_e8: reservePolRune?.toString() ?? null,
      reserve_pol_usd_e8: reservePolRune === null ? null : e8Product(reservePolRune, runePrice).toString(),
      runepool_reserve_owned_rune_e8: reserveOwnedRune?.toString() ?? null,
      runepool_reserve_owned_usd_e8: reserveOwnedRune === null ? null : e8Product(reserveOwnedRune, runePrice).toString(),
      runepool_provider_owned_rune_e8: providerOwnedRune?.toString() ?? null,
      pool_count: poolRows.length,
      treasury_pool_count: poolRows.filter((row) => positive(row.treasury_lp_units) > 0n).length,
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
