// Liquidity-provider redeem values derived the way THORNode's querier does.

function positive(value) {
  if (typeof value === 'bigint') return value > 0n ? value : 0n;
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return 0n;
  return BigInt(normalized);
}

// Mirrors THORNode common.GetSafeShare: cap the ownership ratio and round the
// final positive integer division half up.
export function safeShare(part, total, allocation) {
  const denominator = positive(total);
  const depth = positive(allocation);
  const units = positive(part);
  if (units === 0n || denominator === 0n || depth === 0n) return 0n;
  if (units >= denominator) return depth;
  return ((depth * units) + (denominator / 2n)) / denominator;
}

/** Redeem values for `units` against a /thorchain/pools row (pool_units includes synth units). */
export function lpRedeemValues(units, pool) {
  return {
    rune_redeem_value: safeShare(units, pool?.pool_units, pool?.balance_rune).toString(),
    asset_redeem_value: safeShare(units, pool?.pool_units, pool?.balance_asset).toString()
  };
}
