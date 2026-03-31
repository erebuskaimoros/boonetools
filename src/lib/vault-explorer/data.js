import {
  getAsgardVaults,
  sortVaultsByStatus,
  formatVaultName,
  calculateVaultBond,
  calculateVaultAssetValue,
  VAULT_STATUS
} from '$lib/utils/network';
import { fetchJSONWithFallback } from '$lib/utils/api';
import { fromBaseUnit, getAssetType, normalizeAsset } from '$lib/utils/blockchain';
import { getNodes } from '$lib/utils/nodes';
import { getAssetDisplayName } from '$lib/constants';

/**
 * Fetch and process all vault explorer data.
 * Returns a structured model for the visualization.
 */
export async function fetchVaultExplorerData() {
  const [rawVaults, poolsData, networkData, nodesData, tradeUnits, securedAssets, inboundAddresses] = await Promise.all([
    getAsgardVaults(),
    fetchJSONWithFallback('/thorchain/pools'),
    fetchJSONWithFallback('/thorchain/network'),
    getNodes(),
    fetchJSONWithFallback('/thorchain/trade/units').catch(() => []),
    fetchJSONWithFallback('/thorchain/securedassets').catch(() => []),
    fetchJSONWithFallback('/thorchain/inbound_addresses').catch(() => [])
  ]);

  const vaults = sortVaultsByStatus(rawVaults);
  const activeVaults = vaults.filter(v => v.status === VAULT_STATUS.ACTIVE);
  const runePrice = fromBaseUnit(networkData.rune_price_in_tor);

  // Build price map from pools: { poolAsset: priceUSD }
  // Also build normalized-to-pool lookup for trade/secured mapping
  const prices = {};
  const normalizedToPool = {};
  const poolStatus = {};
  for (const pool of poolsData) {
    prices[pool.asset] = fromBaseUnit(pool.asset_tor_price);
    const norm = normalizeAsset(pool.asset);
    normalizedToPool[norm] = pool.asset;
    poolStatus[pool.asset] = pool.status;
  }

  // Derive effective RUNE price from pools (AMM invariant: RUNE value = asset value per pool)
  // This stays consistent with asset_tor_price valuations used for all other assets
  let totalPoolAssetValueUSD = 0;
  let totalPoolRuneAmount = 0;
  for (const pool of poolsData) {
    const balAsset = fromBaseUnit(pool.balance_asset);
    const balRune = fromBaseUnit(pool.balance_rune);
    const assetPrice = fromBaseUnit(pool.asset_tor_price);
    if (balRune > 0 && balAsset > 0) {
      totalPoolAssetValueUSD += balAsset * assetPrice;
      totalPoolRuneAmount += balRune;
    }
  }
  const effectiveRunePrice = totalPoolRuneAmount > 0 ? totalPoolAssetValueUSD / totalPoolRuneAmount : runePrice;

  prices['THOR.RUNE'] = effectiveRunePrice;
  poolStatus['THOR.RUNE'] = 'Available';

  // Build trade/secured depth maps keyed by pool asset
  // Trade units: { asset: "AVAX~AVAX", depth: "123" } → map to pool via normalizeAsset
  const tradeByPool = {};
  for (const tu of tradeUnits) {
    const depth = fromBaseUnit(tu.depth);
    if (depth <= 0) continue;
    const norm = normalizeAsset(tu.asset);
    const poolAsset = normalizedToPool[norm];
    if (!poolAsset || !prices[poolAsset]) continue;
    if (!tradeByPool[poolAsset]) tradeByPool[poolAsset] = { amount: 0, valueUSD: 0 };
    tradeByPool[poolAsset].amount += depth;
    tradeByPool[poolAsset].valueUSD += depth * prices[poolAsset];
  }

  // Secured assets: { asset: "AVAX-AVAX", depth: "123" }
  const securedByPool = {};
  for (const sa of securedAssets) {
    const depth = fromBaseUnit(sa.depth);
    if (depth <= 0) continue;
    const norm = normalizeAsset(sa.asset);
    const poolAsset = normalizedToPool[norm];
    if (!poolAsset || !prices[poolAsset]) continue;
    if (!securedByPool[poolAsset]) securedByPool[poolAsset] = { amount: 0, valueUSD: 0 };
    securedByPool[poolAsset].amount += depth;
    securedByPool[poolAsset].valueUSD += depth * prices[poolAsset];
  }

  // Build per-pool per-vault aggregation from vault coins (actual L1 balances)
  const poolMap = {};

  for (let vi = 0; vi < activeVaults.length; vi++) {
    const vault = activeVaults[vi];
    for (const coin of vault.coins || []) {
      const poolAsset = coin.asset;
      if (!prices[poolAsset]) continue;

      const amount = fromBaseUnit(coin.amount);
      const valueUSD = amount * prices[poolAsset];

      if (!poolMap[poolAsset]) poolMap[poolAsset] = {};
      const existing = poolMap[poolAsset][vi] || { amount: 0, valueUSD: 0 };
      poolMap[poolAsset][vi] = {
        amount: existing.amount + amount,
        valueUSD: existing.valueUSD + valueUSD
      };
    }
  }

  // RUNE amounts from real API data, valued at effectiveRunePrice for consistency
  // Pool ratio: RUNE per unit of asset in each pool (for deriving trade/secured RUNE)
  const poolRuneRatio = {};
  for (const pool of poolsData) {
    const balAsset = fromBaseUnit(pool.balance_asset);
    const balRune = fromBaseUnit(pool.balance_rune);
    if (balAsset > 0) poolRuneRatio[pool.asset] = balRune / balAsset;
  }

  // Pooled RUNE: available_pools_rune from network endpoint
  // Defined as "RUNE in Available pools (equal in value to the Assets in those pools)"
  const availablePoolsRune = fromBaseUnit(networkData.available_pools_rune);
  if (availablePoolsRune > 0) {
    const perVault = availablePoolsRune / activeVaults.length;
    const perVaultUSD = perVault * effectiveRunePrice;
    poolMap['THOR.RUNE'] = {};
    for (let vi = 0; vi < activeVaults.length; vi++) {
      poolMap['THOR.RUNE'][vi] = { amount: perVault, valueUSD: perVaultUSD };
    }
  }

  // Trade-backing RUNE: RUNE equivalent of trade positions via pool ratios
  let tradeRuneAmount = 0;
  for (const tu of tradeUnits) {
    const depth = fromBaseUnit(tu.depth);
    if (depth <= 0) continue;
    const norm = normalizeAsset(tu.asset);
    const poolAsset = normalizedToPool[norm];
    if (poolAsset && poolRuneRatio[poolAsset]) {
      tradeRuneAmount += depth * poolRuneRatio[poolAsset];
    }
  }
  if (tradeRuneAmount > 0) {
    tradeByPool['THOR.RUNE'] = { amount: tradeRuneAmount, valueUSD: tradeRuneAmount * effectiveRunePrice };
  }

  // Secured-backing RUNE: RUNE equivalent of secured positions via pool ratios
  let securedRuneAmount = 0;
  for (const sa of securedAssets) {
    const depth = fromBaseUnit(sa.depth);
    if (depth <= 0) continue;
    const norm = normalizeAsset(sa.asset);
    const poolAsset = normalizedToPool[norm];
    if (poolAsset && poolRuneRatio[poolAsset]) {
      securedRuneAmount += depth * poolRuneRatio[poolAsset];
    }
  }
  if (securedRuneAmount > 0) {
    securedByPool['THOR.RUNE'] = { amount: securedRuneAmount, valueUSD: securedRuneAmount * effectiveRunePrice };
  }

  const TYPE_META = {
    native: { label: 'Pooled', color: '#00cc66', colorAlpha: 'rgba(0, 204, 102, 0.5)', order: 0 },
    trade: { label: 'Trade', color: '#5588cc', colorAlpha: 'rgba(85, 136, 204, 0.5)', order: 1 },
    secured: { label: 'Secured', color: '#d4a017', colorAlpha: 'rgba(212, 160, 23, 0.5)', order: 2 }
  };

  let pooledTotalUSD = 0;
  let tradeTotalUSD = 0;
  let securedTotalUSD = 0;

  // Collect all pool assets that have any data (native, trade, or secured)
  const allPoolAssets = new Set([
    ...Object.keys(poolMap),
    ...Object.keys(tradeByPool),
    ...Object.keys(securedByPool)
  ]);

  const pools = [...allPoolAssets].map(poolAsset => {
    let poolTotalUSD = 0;
    let maxCellValue = 0;
    const assetTypes = [];

    // Native (pooled) — per-vault distribution
    const vaultData = poolMap[poolAsset];
    if (vaultData) {
      let totalAmount = 0;
      let totalValueUSD = 0;

      const vaultBalances = activeVaults.map((vault, vi) => {
        const cell = vaultData[vi] || { amount: 0, valueUSD: 0 };
        totalAmount += cell.amount;
        totalValueUSD += cell.valueUSD;
        if (cell.valueUSD > maxCellValue) maxCellValue = cell.valueUSD;
        return {
          vaultIndex: vi,
          vaultName: formatVaultName(vault.pub_key),
          amount: cell.amount,
          valueUSD: cell.valueUSD
        };
      });

      if (totalValueUSD > 0) {
        poolTotalUSD += totalValueUSD;
        pooledTotalUSD += totalValueUSD;
        assetTypes.push({
          type: 'native',
          ...TYPE_META.native,
          vaultBalances,
          totalAmount,
          totalValueUSD,
          isPerVault: true
        });
      }
    }

    // Trade — global total (not per-vault)
    const trade = tradeByPool[poolAsset];
    if (trade && trade.valueUSD > 0) {
      poolTotalUSD += trade.valueUSD;
      tradeTotalUSD += trade.valueUSD;
      if (trade.valueUSD > maxCellValue) maxCellValue = trade.valueUSD;
      assetTypes.push({
        type: 'trade',
        ...TYPE_META.trade,
        totalAmount: trade.amount,
        totalValueUSD: trade.valueUSD,
        isPerVault: false
      });
    }

    // Secured — global total (not per-vault)
    const secured = securedByPool[poolAsset];
    if (secured && secured.valueUSD > 0) {
      poolTotalUSD += secured.valueUSD;
      securedTotalUSD += secured.valueUSD;
      if (secured.valueUSD > maxCellValue) maxCellValue = secured.valueUSD;
      assetTypes.push({
        type: 'secured',
        ...TYPE_META.secured,
        totalAmount: secured.amount,
        totalValueUSD: secured.valueUSD,
        isPerVault: false
      });
    }

    assetTypes.sort((a, b) => a.order - b.order);

    // Compute total tokens across all asset types for row proportions
    const totalTokens = assetTypes.reduce((s, at) => s + at.totalAmount, 0);
    for (const at of assetTypes) {
      at.pct = totalTokens > 0 ? at.totalAmount / totalTokens : 0;
    }

    // Compute vault column proportions from pooled (native) per-vault data
    const nativeType = assetTypes.find(at => at.type === 'native');
    const vaultPcts = activeVaults.map((_, vi) => {
      if (!nativeType) return 1 / activeVaults.length;
      const vaultAmount = nativeType.vaultBalances[vi]?.amount || 0;
      return nativeType.totalAmount > 0 ? vaultAmount / nativeType.totalAmount : 1 / activeVaults.length;
    });

    return {
      poolAsset,
      displayName: getAssetDisplayName(poolAsset),
      status: poolStatus[poolAsset] || 'Unknown',
      totalValueUSD: poolTotalUSD,
      assetTypes,
      maxCellValue,
      vaultPcts,
      totalTokens
    };
  })
    .filter(p => p.totalValueUSD > 0 && p.assetTypes.length > 0)
    .sort((a, b) => b.totalValueUSD - a.totalValueUSD);

  const totalVaultValueUSD = pools.reduce((s, p) => s + p.totalValueUSD, 0);

  const vaultModels = activeVaults.map(v => ({
    name: formatVaultName(v.pub_key),
    pubKey: v.pub_key,
    status: v.status,
    addresses: v.addresses || []
  }));

  return {
    vaults: vaultModels,
    pools,
    summary: {
      totalVaultValueUSD,
      activeVaultCount: activeVaults.length,
      totalPools: pools.length,
      pooledTotalUSD,
      tradeTotalUSD,
      securedTotalUSD
    },
    rawVaults: vaults,
    routers: Object.fromEntries(inboundAddresses.filter(a => a.router).map(a => [a.chain, a.router])),
    prices,
    runePrice,
    nodesData,
    poolsData
  };
}
