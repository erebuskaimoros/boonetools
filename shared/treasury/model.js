import { NATIVE_ASSET_BY_CHAIN } from './config.js';

const BASE_UNIT = 1e8;

export function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function fromBaseUnit(value) {
  return safeNumber(value) / BASE_UNIT;
}

export function hasKnownUsdValue(value) {
  return value != null && Number.isFinite(Number(value));
}

export function denomToTreasuryAsset(denom) {
  const normalized = String(denom || '');
  const lower = normalized.toLowerCase();
  if (!lower) return '';
  if (lower === 'rune') return 'THOR.RUNE';
  if (lower === 'tcy') return 'THOR.TCY';
  if (lower === 'ruji') return 'THOR.RUJI';
  if (lower.startsWith('thor.')) return lower.split('.').map((part) => part.toUpperCase()).join('.');
  if (lower.startsWith('synth/')) return `THOR.${lower.slice('synth/'.length).toUpperCase()}`;

  const dashParts = lower.split('-');
  if (dashParts.length === 2 && dashParts[0] === dashParts[1]) {
    return `THOR.${dashParts[1].toUpperCase()}`;
  }
  if (dashParts.length >= 2) {
    return `${dashParts[0].toUpperCase()}.${dashParts.slice(1).join('-').toUpperCase()}`;
  }
  return `THOR.${normalized.toUpperCase()}`;
}

export function buildAssetPriceIndex(pools = [], runePrice = 0) {
  const prices = { 'THOR.RUNE': safeNumber(runePrice) };

  for (const pool of pools) {
    if (!pool?.asset || pool.status !== 'Available') continue;
    const price = fromBaseUnit(pool.asset_tor_price);
    if (!(price > 0)) continue;
    prices[pool.asset] = price;
    const assetPart = String(pool.asset).split('.').slice(1).join('.');
    if (assetPart) prices[`THOR.${assetPart}`] = price;
  }

  return prices;
}

export function trackedEvmAssetsByChain(pools = []) {
  return ['BSC', 'AVAX', 'BASE'].reduce((result, chain) => {
    result[chain] = [...new Set(pools
      .filter((pool) => pool?.status === 'Available')
      .map((pool) => String(pool.asset || ''))
      .filter((asset) => asset.startsWith(`${chain}.`) && /-0X/i.test(asset)))];
    return result;
  }, {});
}

export function buildBondsByAddress(nodes = [], addresses = []) {
  const addressSet = new Set(addresses.map((address) => String(address).toLowerCase()));
  const bondsByAddress = {};

  for (const node of nodes) {
    for (const provider of node?.bond_providers?.providers || []) {
      const address = String(provider?.bond_address || '');
      const key = address.toLowerCase();
      if (!addressSet.has(key)) continue;
      const nodeAddress = String(node?.node_address || '');
      (bondsByAddress[key] ||= []).push({
        nodeAddress,
        nodeSuffix: nodeAddress.slice(-4),
        bondAddress: address,
        rawAmount: String(provider?.bond || '0'),
        amount: fromBaseUnit(provider?.bond),
        nodeStatus: node?.status || 'Unknown',
        nodePubKey: node?.pub_key_set?.secp256k1 || null,
        nodeIpAddress: node?.ip_address || null,
        nodeVersion: node?.version || null
      });
    }
  }

  return bondsByAddress;
}

export function mergeDenomBalances(primaryBalances = [], secondaryBalances = []) {
  const byDenom = new Map();
  for (const balance of secondaryBalances) {
    if (balance?.denom) byDenom.set(balance.denom, balance);
  }
  for (const balance of primaryBalances) {
    if (balance?.denom) byDenom.set(balance.denom, balance);
  }
  return [...byDenom.values()];
}

export function enrichHolding(holding, assetPrices = {}) {
  const amount = safeNumber(holding?.amount);
  const knownValue = hasKnownUsdValue(holding?.usdValue);
  const price = assetPrices[holding?.asset];
  const usdValue = knownValue
    ? safeNumber(holding.usdValue)
    : hasKnownUsdValue(price) && safeNumber(price) > 0
      ? amount * safeNumber(price)
      : null;

  return {
    ...holding,
    amount,
    usdValue,
    hasMissingPrice: !hasKnownUsdValue(usdValue)
  };
}

export function buildThorHoldings(balances = [], assetPrices = {}) {
  return balances
    .map((balance) => enrichHolding({
      asset: denomToTreasuryAsset(balance?.denom),
      chain: 'THOR',
      amount: fromBaseUnit(balance?.amount)
    }, assetPrices))
    .filter((holding) => holding.amount > 0)
    .sort(compareHoldings);
}

export function normalizeHoldings(holdings = [], assetPrices = {}) {
  return holdings
    .map((holding) => enrichHolding(holding, assetPrices))
    .filter((holding) => holding.amount > 0)
    .sort(compareHoldings);
}

function compareHoldings(left, right) {
  const leftValue = left.usdValue ?? left.amount;
  const rightValue = right.usdValue ?? right.amount;
  return rightValue - leftValue;
}

export function toTreasuryLpPosition(data, assetPrices = {}, runePrice = 0) {
  if (!data?.asset) return null;
  const assetAmount = fromBaseUnit(data.asset_redeem_value);
  const runeAmount = fromBaseUnit(data.rune_redeem_value);
  const assetUsdValue = assetAmount * safeNumber(assetPrices[data.asset]);
  const runeUsdValue = runeAmount * safeNumber(runePrice);

  return {
    pool: String(data.asset).split('.')[1]?.split('-')[0] || data.asset,
    fullPool: data.asset,
    assetAmount,
    runeAmount,
    assetUsdValue,
    runeUsdValue,
    totalUsdValue: assetUsdValue + runeUsdValue
  };
}

export function finalizeTreasuryEntry(entry, pieces = {}) {
  const balances = Array.isArray(pieces.balances) ? pieces.balances : [];
  const stakedPositions = Array.isArray(pieces.stakedPositions) ? pieces.stakedPositions : [];
  const lpPositions = (Array.isArray(pieces.lpPositions) ? pieces.lpPositions : [])
    .filter((position) => safeNumber(position?.totalUsdValue) >= 1)
    .sort((left, right) => safeNumber(right.totalUsdValue) - safeNumber(left.totalUsdValue));
  const bonds = (Array.isArray(pieces.bonds) ? pieces.bonds : [])
    .filter((bond) => safeNumber(bond?.amount) > 0);
  const summary = summarizeEntry({ balances, stakedPositions, lpPositions, bonds }, pieces.runePrice);

  return {
    ...entry,
    moduleBalances: undefined,
    primaryAsset: entry.primaryAsset
      || balances[0]?.asset
      || stakedPositions[0]?.asset
      || NATIVE_ASSET_BY_CHAIN[entry.chain],
    balances,
    stakedPositions,
    lpPositions,
    bonds,
    entryError: pieces.entryError || null,
    summary
  };
}

export function summarizeEntry(entry, runePrice = 0) {
  const walletValue = (entry?.balances || []).reduce(
    (total, holding) => total + safeNumber(holding?.usdValue),
    0
  );
  const stakeValue = (entry?.stakedPositions || []).reduce(
    (total, position) => total + safeNumber(position?.usdValue),
    0
  );
  const lpValue = (entry?.lpPositions || []).reduce(
    (total, position) => total + safeNumber(position?.totalUsdValue),
    0
  );
  const bondValue = (entry?.bonds || []).reduce(
    (total, bond) => total + safeNumber(bond?.amount) * safeNumber(runePrice),
    0
  );

  return {
    walletValue,
    stakeValue,
    lpValue,
    bondValue,
    totalValue: walletValue + stakeValue + lpValue + bondValue
  };
}

export function summarizeSection(entries = []) {
  return entries.reduce((summary, entry) => {
    summary.walletValue += safeNumber(entry?.summary?.walletValue);
    summary.stakeValue += safeNumber(entry?.summary?.stakeValue);
    summary.lpValue += safeNumber(entry?.summary?.lpValue);
    summary.bondValue += safeNumber(entry?.summary?.bondValue);
    summary.totalValue += safeNumber(entry?.summary?.totalValue);
    return summary;
  }, {
    addressCount: entries.length,
    walletValue: 0,
    stakeValue: 0,
    lpValue: 0,
    bondValue: 0,
    totalValue: 0
  });
}

export function buildConsolidatedSection(sourceSections = []) {
  const entries = sourceSections.flatMap((section) => section.entries || []);
  const balancesByAsset = new Map();
  const stakedByAsset = new Map();
  const positionsByPool = new Map();
  const bondsByNode = new Map();

  for (const entry of entries) {
    for (const balance of entry.balances || []) {
      const existing = balancesByAsset.get(balance.asset) || {
        asset: balance.asset,
        chain: balance.chain,
        amount: 0,
        usdValue: 0,
        hasMissingPrice: false
      };
      existing.amount += safeNumber(balance.amount);
      existing.usdValue += safeNumber(balance.usdValue);
      existing.hasMissingPrice ||= Boolean(balance.hasMissingPrice) || !hasKnownUsdValue(balance.usdValue);
      balancesByAsset.set(balance.asset, existing);
    }

    for (const position of entry.stakedPositions || []) {
      const existing = stakedByAsset.get(position.asset) || {
        asset: position.asset,
        chain: position.chain,
        amount: 0,
        usdValue: 0,
        hasMissingPrice: false
      };
      existing.amount += safeNumber(position.amount);
      existing.usdValue += safeNumber(position.usdValue);
      existing.hasMissingPrice ||= Boolean(position.hasMissingPrice) || !hasKnownUsdValue(position.usdValue);
      stakedByAsset.set(position.asset, existing);
    }

    for (const position of entry.lpPositions || []) {
      const existing = positionsByPool.get(position.fullPool) || {
        pool: position.pool,
        fullPool: position.fullPool,
        assetAmount: 0,
        runeAmount: 0,
        assetUsdValue: 0,
        runeUsdValue: 0,
        totalUsdValue: 0
      };
      for (const key of ['assetAmount', 'runeAmount', 'assetUsdValue', 'runeUsdValue', 'totalUsdValue']) {
        existing[key] += safeNumber(position[key]);
      }
      positionsByPool.set(position.fullPool, existing);
    }

    for (const bond of entry.bonds || []) {
      const key = String(bond.nodeAddress || '').toLowerCase();
      const existing = bondsByNode.get(key) || {
        nodeAddress: bond.nodeAddress,
        nodeStatus: bond.nodeStatus,
        amount: 0
      };
      existing.amount += safeNumber(bond.amount);
      if (existing.nodeStatus !== bond.nodeStatus) existing.nodeStatus = 'Mixed';
      bondsByNode.set(key, existing);
    }
  }

  return {
    key: 'consolidated',
    title: 'Consolidated Positions',
    description: `Aggregated balances, staked positions, LP positions, and node bonds across ${entries.length} tracked treasury addresses.`,
    balances: [...balancesByAsset.values()].sort(compareHoldings),
    stakedPositions: [...stakedByAsset.values()].sort(compareHoldings),
    lpPositions: [...positionsByPool.values()]
      .sort((left, right) => right.totalUsdValue - left.totalUsdValue),
    bonds: [...bondsByNode.values()].sort((left, right) => right.amount - left.amount),
    summary: summarizeSection(entries)
  };
}

export function countUnpricedBalances(sourceSections = []) {
  return sourceSections
    .flatMap((section) => section.entries || [])
    .flatMap((entry) => [...(entry.balances || []), ...(entry.stakedPositions || [])])
    .filter((balance) => balance.hasMissingPrice)
    .length;
}
