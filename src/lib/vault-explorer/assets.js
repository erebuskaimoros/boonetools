const ASSET_BUCKETS = {
  native: 'pooled',
  trade: 'trade',
  secured: 'secured'
};

function emptyBucket() {
  return { amount: 0, valueUSD: 0 };
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
