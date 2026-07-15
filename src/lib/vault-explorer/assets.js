const ASSET_BUCKETS = {
  native: 'pooled',
  trade: 'trade',
  secured: 'secured'
};

const THOR_BASE = 1e8;

function emptyBucket() {
  return { amount: 0, valueUSD: 0 };
}

/**
 * Build true pool balances from /thorchain/pools while retaining the physical
 * vault distribution for the overview mosaic. Vault inventory is broader than
 * pooled inventory because it also contains trade and secured assets.
 */
export function buildPooledBalanceMap(pools = [], prices = {}, vaultInventoryMap = {}, vaultCount = 0) {
  const pooledBalanceMap = {};

  for (const pool of pools) {
    const amount = Number(pool?.balance_asset || 0) / THOR_BASE;
    const price = Number(prices[pool?.asset]) || 0;
    if (!pool?.asset || amount <= 0 || price <= 0) continue;

    const inventoryByVault = vaultInventoryMap[pool.asset] || {};
    const weights = Array.from({ length: vaultCount }, (_, vaultIndex) => (
      Math.max(Number(inventoryByVault[vaultIndex]?.amount) || 0, 0)
    ));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

    pooledBalanceMap[pool.asset] = {};
    for (let vaultIndex = 0; vaultIndex < vaultCount; vaultIndex++) {
      const share = totalWeight > 0 ? weights[vaultIndex] / totalWeight : 1 / vaultCount;
      pooledBalanceMap[pool.asset][vaultIndex] = {
        amount: amount * share,
        valueUSD: amount * price * share
      };
    }
  }

  return pooledBalanceMap;
}

/**
 * Use the same pool rows for the RUNE side so pooled RUNE and exogenous pool
 * depth have identical scope. The shared effective RUNE price then makes the
 * total pooled value exactly twice the exogenous side.
 */
export function getPooledRuneAmount(pools = []) {
  return pools.reduce((total, pool) => {
    const assetAmount = Number(pool?.balance_asset || 0) / THOR_BASE;
    const runeAmount = Number(pool?.balance_rune || 0) / THOR_BASE;
    return assetAmount > 0 && runeAmount > 0 ? total + runeAmount : total;
  }, 0);
}

/**
 * Flatten the Vault Explorer pool model into one row per exogenous asset.
 * THOR.RUNE is deliberately excluded because it is endogenous to THORChain.
 */
export function buildCustodiedAssetRows(pools = []) {
  return pools
    .filter((pool) => pool?.poolAsset && pool.poolAsset !== 'THOR.RUNE')
    .map((pool) => {
      const buckets = {
        pooled: emptyBucket(),
        trade: emptyBucket(),
        secured: emptyBucket()
      };

      for (const assetType of pool.assetTypes || []) {
        const bucketName = ASSET_BUCKETS[assetType.type];
        if (!bucketName) continue;

        buckets[bucketName].amount += Number(assetType.totalAmount) || 0;
        buckets[bucketName].valueUSD += Number(assetType.totalValueUSD) || 0;
      }

      const totalAmount = Object.values(buckets).reduce((sum, bucket) => sum + bucket.amount, 0);
      const totalValueUSD = Object.values(buckets).reduce((sum, bucket) => sum + bucket.valueUSD, 0);

      return {
        poolAsset: pool.poolAsset,
        chain: pool.poolAsset.split('.')[0],
        displayName: pool.displayName,
        status: pool.status,
        totalAmount,
        totalValueUSD,
        ...buckets
      };
    })
    .filter((asset) => asset.totalAmount > 0 || asset.totalValueUSD > 0)
    .sort((a, b) => b.totalValueUSD - a.totalValueUSD || a.poolAsset.localeCompare(b.poolAsset));
}

export function summarizeCustodiedAssetRows(assets = []) {
  return assets.reduce((summary, asset) => {
    summary.assetCount += 1;
    summary.totalValueUSD += Number(asset.totalValueUSD) || 0;
    summary.pooledTotalUSD += Number(asset.pooled?.valueUSD) || 0;
    summary.tradeTotalUSD += Number(asset.trade?.valueUSD) || 0;
    summary.securedTotalUSD += Number(asset.secured?.valueUSD) || 0;
    return summary;
  }, {
    assetCount: 0,
    totalValueUSD: 0,
    pooledTotalUSD: 0,
    tradeTotalUSD: 0,
    securedTotalUSD: 0
  });
}
