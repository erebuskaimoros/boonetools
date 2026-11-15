const base = value => BigInt(value ?? '0');

// Fee/gas accounting drift leaves L1 a few sats below THORNode; only deficits
// above this fraction of THORNode's amount are treated as material.
export const SHORTFALL_TOLERANCE_BPS = 1n;
// Matches the backend's 90 s L1 check expiry: once checks read stale, say why.
export const BALANCE_DELAY_MS = 90_000;

export function describeBalance(coin, now = Date.now()) {
  const verified = coin.balance_status === 'verified';
  const fresh = verified && Date.parse(coin.balance_expires_at || '') > now;
  const expected = coin.thornode_amount ?? (verified ? null : coin.amount);
  const delta = verified && expected != null ? base(coin.amount) - base(expected) : null;
  const material = delta != null && delta < 0n && -delta * 10000n > base(expected) * SHORTFALL_TOLERANCE_BPS;
  return {
    verified, fresh, expected,
    amount: verified ? coin.amount : null,
    delta: delta == null ? null : delta.toString(),
    shortfall: material,
    withinTolerance: delta != null && delta < 0n && !material,
    state: verified ? (fresh ? 'verified' : 'stale') : coin.balance_status || 'unsupported',
    label: verified ? (fresh ? (coin.balance_scope === 'router_allowance' ? 'L1 allowance' : 'L1 balance') : 'L1 stale')
      : coin.balance_status === 'unavailable' ? 'L1 unavailable' : 'THORNode only',
    detail: verified
      ? `${coin.balance_provider} · ${coin.balance_observed_at}${coin.balance_block ? ` · block/slot ${coin.balance_block}` : ''}`
      : coin.balance_error || 'No independent L1 balance is available for this asset.'
  };
}

export function getVisibleVaultCoins(vault, prices = {}) {
  return [...(vault.coins || [])]
    .filter(coin => base(coin.amount) > 0n || base(coin.thornode_amount) > 0n)
    .sort((a, b) => {
      const aState = describeBalance(a), bState = describeBalance(b);
      // Depleted assets must remain visible, including tokens without a price.
      if (aState.shortfall !== bState.shortfall) return aState.shortfall ? -1 : 1;
      return Math.max(Number(b.amount), Number(b.thornode_amount || 0)) * (prices[b.asset] || 0)
        - Math.max(Number(a.amount), Number(a.thornode_amount || 0)) * (prices[a.asset] || 0);
    });
}

export function summarizeVaultBalances(vault, prices = {}, now = Date.now()) {
  const coins = getVisibleVaultCoins(vault, prices);
  const result = { total: coins.length, fresh: 0, unavailable: 0, stale: 0, shortfalls: 0, withinTolerance: 0, valueUSD: 0, unpriced: 0 };
  for (const coin of coins) {
    const state = describeBalance(coin, now);
    if (state.fresh) {
      result.fresh++;
      if (prices[coin.asset]) result.valueUSD += Number(coin.amount) / 1e8 * prices[coin.asset];
      else if (base(coin.amount) > 0n) result.unpriced++;
      if (state.shortfall) result.shortfalls++;
      if (state.withinTolerance) result.withinTolerance++;
    } else if (state.verified) result.stale++;
    else result.unavailable++;
  }
  return result;
}

export function routerCheckStatus(check, now = Date.now()) {
  if (check.status === 'unavailable') return 'unavailable';
  if (!(Date.parse(check.observed_at) + 90_000 > now)) return 'stale';
  return check.status;
}

/** Age in ms of the older of the vault and L1 balance observations, or null when either is missing. */
export function balanceObservationAge(fieldMeta, now = Date.now()) {
  const times = ['vaults', 'l1_balances'].map(field => Date.parse(fieldMeta?.[field]?.fetched_at || ''));
  if (times.some(Number.isNaN)) return null;
  return now - Math.min(...times);
}

/** True when vault or L1 balance observations are missing or older than BALANCE_DELAY_MS. */
export function balancesDelayed(fieldMeta, now = Date.now()) {
  const age = balanceObservationAge(fieldMeta, now);
  return age == null || age > BALANCE_DELAY_MS;
}
