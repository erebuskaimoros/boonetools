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
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
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

export function buildSystemIncomeDistribution(mimir = {}, constants = {}) {
  const explicit = SYSTEM_INCOME_ALLOCATION_CONFIG.map((config) => (
    resolveAllocation(config, mimir, constants)
  ));
  const complete = explicit.every((allocation) => allocation.bps !== null);
  const explicitBps = complete
    ? explicit.reduce((total, allocation) => total + allocation.bps, 0)
    : null;
  const incentivePendulumBps = explicitBps === null
    ? null
    : Math.max(0, TOTAL_BASIS_POINTS - explicitBps);
  const incentivePendulum = {
    id: 'ip',
    label: 'Bond Providers',
    shortLabel: 'BOND PROVIDERS',
    mimirKey: null,
    constantKey: null,
    color: '#00cc66',
    bps: incentivePendulumBps,
    percent: incentivePendulumBps === null ? null : incentivePendulumBps / 100,
    source: 'derived'
  };

  return {
    allocations: [...explicit.slice(0, 4), incentivePendulum, explicit[4]],
    complete,
    explicitBps,
    totalBps: explicitBps === null ? null : explicitBps + incentivePendulumBps,
    overflowBps: explicitBps === null ? null : Math.max(0, explicitBps - TOTAL_BASIS_POINTS)
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
