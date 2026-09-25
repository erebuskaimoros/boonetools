const TOTAL_BASIS_POINTS = 10_000;

export const SYSTEM_INCOME_ALLOCATION_CONFIG = Object.freeze([
  {
    id: 'burn',
    label: 'Burn',
    shortLabel: 'BURN',
    mimirKey: 'SYSTEMINCOMEBURNRATEBPS',
    constantKey: 'SystemIncomeBurnRateBps',
    color: '#e05260'
  },
  {
    id: 'dev',
    label: 'Dev Fund',
    shortLabel: 'DEV',
    mimirKey: 'DEVFUNDSYSTEMINCOMEBPS',
    constantKey: 'DevFundSystemIncomeBps',
    color: '#c8c8c8'
  },
  {
    id: 'tcy',
    label: 'TCY Stakers',
    shortLabel: 'TCY',
    mimirKey: 'TCYSTAKESYSTEMINCOMEBPS',
    constantKey: 'TCYStakeSystemIncomeBps',
    color: '#5588cc'
  },
  {
    id: 'marketing',
    label: 'Marketing',
    shortLabel: 'MKT',
    mimirKey: 'MARKETINGFUNDSYSTEMINCOMEBPS',
    constantKey: 'MarketingFundSystemIncomeBps',
    color: '#b2b2b2'
  },
  {
    id: 'pol',
    label: 'Protocol-Owned Liquidity',
    shortLabel: 'POL',
    mimirKey: 'POLRESERVESYSTEMINCOMEBPS',
    constantKey: 'POLReserveSystemIncomeBps',
    color: '#d4a017'
  }
]);

function caseInsensitiveValue(object, key) {
  const entry = Object.entries(object && typeof object === 'object' ? object : {})
    .find(([candidate]) => candidate.toUpperCase() === key.toUpperCase());
  return entry?.[1];
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function resolveAllocation(config, mimir, constants) {
  const override = nonNegativeInteger(caseInsensitiveValue(mimir, config.mimirKey));
  const fallback = nonNegativeInteger(caseInsensitiveValue(constants?.int_64_values, config.constantKey));
  const bps = override ?? fallback;
  return {
    ...config,
    bps,
    percent: bps === null ? null : bps / 100,
    source: override !== null ? 'mimir' : fallback !== null ? 'constant' : 'unavailable'
  };
}

function atomicAmount(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!/^\d+$/.test(String(value))) return null;
  return BigInt(value);
}

/** Current-state estimate of THORNode getPoolShare, not a historical payout.
 * Matches the v3.20.2 security hard cap and all three Pendulum config levers.
 * Atomic balances stay BigInt. Reward ratios are computed as rational values,
 * without inventing a block-income amount (actual payouts round per block).
 * https://dev.thorchain.org/concepts/incentive-pendulum.html
 */
export function calculateIncentivePendulum(mimir = {}, constants = {}, network = {}, nodes = []) {
  const unavailable = error => ({ available: false, error, lpFraction: null, bondFraction: null });
  const config = key => resolveAllocation({ mimirKey: key.toUpperCase(), constantKey: key }, mimir, constants).bps;
  const assetsBps = config('PendulumAssetsBasisPoints');
  const securityFlag = config('PendulumUseEffectiveSecurity');
  const vaultFlag = config('PendulumUseVaultAssets');
  if ([assetsBps, securityFlag, vaultFlag].some(value => value === null)) {
    return unavailable('Pendulum settings are unavailable.');
  }
  const useEffectiveSecurity = securityFlag > 0, useVaultAssets = vaultFlag > 0;
  const pooledRune = atomicAmount(network?.available_pools_rune);
  const vaultLiquidity = atomicAmount(network?.vaults_liquidity_rune);
  if (pooledRune === null || pooledRune === 0n || useVaultAssets && (vaultLiquidity === null || vaultLiquidity === 0n)) {
    return unavailable('Current pool/vault liquidity is unavailable.');
  }
  const active = Array.isArray(nodes) ? nodes.filter(node => node?.status === 'Active') : [];
  const bonds = active.map(node => atomicAmount(node.total_bond));
  if (!bonds.length || bonds.some(value => value === null)) return unavailable('Active-node bond data is incomplete.');
  bonds.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const securityCount = Math.ceil(bonds.length * 2 / 3);
  const bondHardCap = bonds[securityCount - 1];
  const effectiveSecurityBond = bonds.slice(0, securityCount).reduce((sum, bond) => sum + bond, 0n);
  const totalEffectiveBond = bonds.reduce((sum, bond) => sum + (bond > bondHardCap ? bondHardCap : bond), 0n);
  if (totalEffectiveBond === 0n || useEffectiveSecurity && effectiveSecurityBond === 0n) {
    return unavailable('Active securing bond is unavailable.');
  }
  const securing = useEffectiveSecurity ? effectiveSecurityBond : totalEffectiveBond;
  const assetValue = useVaultAssets ? vaultLiquidity : pooledRune;
  // GetUncappedShare rounds positive integer values half-up.
  const secured = (assetValue * BigInt(assetsBps) + 5000n) / 10000n;
  let lpFraction = 0;
  if (securing > secured) {
    // Cancel the common securing denominator in the adjusted node/pool shares.
    const nodeNumerator = secured * (useEffectiveSecurity ? totalEffectiveBond : 1n);
    const nodeDenominator = useEffectiveSecurity ? effectiveSecurityBond : 1n;
    const poolNumerator = (securing - secured) * (useVaultAssets ? (pooledRune < vaultLiquidity ? pooledRune : vaultLiquidity) : 1n);
    const poolDenominator = useVaultAssets ? vaultLiquidity : 1n;
    const poolWeight = poolNumerator * nodeDenominator;
    const totalWeight = poolWeight + nodeNumerator * poolDenominator;
    const precision = 1000000000000n;
    lpFraction = Number((poolWeight * precision + totalWeight / 2n) / totalWeight) / Number(precision);
  }
  return {
    available: true, error: '', lpFraction, bondFraction: 1 - lpFraction,
    assetsBps, useEffectiveSecurity, useVaultAssets,
    bondHardCap: String(bondHardCap), effectiveSecurityBond: String(effectiveSecurityBond),
    totalEffectiveBond: String(totalEffectiveBond), activeNodes: active.length
  };
}

export function buildSystemIncomeDistribution(mimir = {}, constants = {}, network = {}, nodes = []) {
  const explicit = SYSTEM_INCOME_ALLOCATION_CONFIG.map((config) => (
    resolveAllocation(config, mimir, constants)
  ));
  const explicitComplete = explicit.every((allocation) => allocation.bps !== null);
  const explicitBps = explicitComplete
    ? explicit.reduce((total, allocation) => total + allocation.bps, 0)
    : null;
  const incentivePendulumBps = explicitBps === null
    ? null
    : Math.max(0, TOTAL_BASIS_POINTS - explicitBps);
  const pendulum = calculateIncentivePendulum(mimir, constants, network, nodes);
  const overflowBps = explicitBps === null ? null : Math.max(0, explicitBps - TOTAL_BASIS_POINTS);
  const complete = explicitComplete && pendulum.available && overflowBps === 0;
  const lpBps = complete ? incentivePendulumBps * pendulum.lpFraction : null;
  const bondBps = complete ? incentivePendulumBps - lpBps : null;
  const bond = {
    id: 'bond',
    label: 'Bond Providers',
    shortLabel: 'BOND PROVIDERS',
    mimirKey: null,
    constantKey: null,
    color: '#00cc66',
    bps: bondBps,
    percent: bondBps === null ? null : bondBps / 100,
    source: 'pendulum',
    detail: pendulum.available ? `${formatSystemIncomePercent(pendulum.bondFraction * 100)} OF THE ${formatSystemIncomePercent(incentivePendulumBps === null ? null : incentivePendulumBps / 100)} REMAINDER` : 'PENDULUM INPUTS UNAVAILABLE'
  };
  const lp = {
    id: 'lp', label: 'Liquidity Providers', shortLabel: 'LPs', color: '#d8d8d8',
    bps: lpBps, percent: lpBps === null ? null : lpBps / 100, source: 'pendulum',
    detail: pendulum.available ? `${formatSystemIncomePercent(pendulum.lpFraction * 100)} OF THE ${formatSystemIncomePercent(incentivePendulumBps === null ? null : incentivePendulumBps / 100)} REMAINDER` : 'PENDULUM INPUTS UNAVAILABLE'
  };

  return {
    allocations: [...explicit.slice(0, 4), bond, lp, explicit[4]],
    complete, explicitComplete, pendulum,
    explicitBps,
    totalBps: complete ? TOTAL_BASIS_POINTS : null,
    overflowBps
  };
}

export function formatSystemIncomePercent(percent) {
  if (percent === null || percent === undefined || percent === '') return '—';
  if (!Number.isFinite(Number(percent))) return '—';
  return `${Number(percent).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })}%`;
}

export function systemIncomeDistributionFlows(distribution) {
  if (!distribution?.complete) return [];
  return (distribution?.allocations || [])
    .filter((allocation) => Number(allocation.bps) > 0)
    .map((allocation) => ({
      from: 'System Income',
      to: allocation.shortLabel,
      flow: allocation.percent,
      color: allocation.color,
      label: allocation.label
    }));
}
