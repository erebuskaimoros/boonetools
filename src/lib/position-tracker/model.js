/**
 * Pure aggregation for the Position Tracker: turns raw THORNode / Midgard
 * payloads into per-address rows and portfolio totals. No network access.
 */

import { estimateCurrentChurnYields } from '../bond-tracker/apy.js';
import { readBondYieldConfig } from './bond-yield.js';
import { isThorAddress } from './addresses.js';

const BASE = 1e8;
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const units = (value) => num(value) / BASE;
const lower = (value) => String(value ?? '').toLowerCase();

// ============================================
// Prices
// ============================================

/** Build { 'BTC.BTC': usd, 'THOR.RUNE': usd } from THORNode pools + network. */
export function buildPriceMap(pools, runePriceUsd) {
  const prices = { 'THOR.RUNE': num(runePriceUsd) };
  for (const pool of Array.isArray(pools) ? pools : []) {
    if (pool?.asset) prices[pool.asset] = units(pool.asset_tor_price);
  }
  return prices;
}

// ============================================
// Churn estimate input (mirrors BondTrackerV2)
// ============================================

export function churnEstimateInput(churnState) {
  if (!churnState) {
    return { lastChurnTimestamp: 0, churnIntervalSeconds: 0, progressedBlocks: 0, totalBlocks: 0, secondsPerBlock: 0 };
  }
  const lastHeight = num(churnState.lastChurnHeight);
  const nextHeight = num(churnState.nextChurnHeight);
  const totalBlocks = Math.max(0, nextHeight - lastHeight || num(churnState.churnIntervalBlocks));
  const progressedBlocks = totalBlocks > 0 ? Math.max(0, num(churnState.currentHeight) - lastHeight) : 0;
  const secondsPerBlock = num(churnState.secondsPerBlock);
  return {
    lastChurnTimestamp: num(churnState.lastChurnTimestamp),
    churnIntervalSeconds: totalBlocks > 0 && secondsPerBlock > 0 ? totalBlocks * secondsPerBlock : 0,
    progressedBlocks,
    totalBlocks,
    secondsPerBlock
  };
}

// ============================================
// Bonds
// ============================================

/**
 * One row per (tracked address, node) with a bond above 1 RUNE.
 * `getLeave` is an optional (node, allNodes) → leave-status callback.
 */
export function buildBondRows({ nodes, addresses, runePriceUsd = 0, churnState = null, getLeave = null }) {
  const tracked = new Set((addresses || []).map(lower));
  const estimate = churnEstimateInput(churnState);
  const rows = [];

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const providers = node?.bond_providers?.providers || [];
    const totalBond = providers.reduce((sum, provider) => sum + num(provider.bond), 0);
    const fee = num(node?.bond_providers?.node_operator_fee) / 10000;
    const award = num(node?.current_award);

    for (const provider of providers) {
      const address = lower(provider.bond_address);
      const bond = num(provider.bond);
      if (!tracked.has(address) || bond <= BASE) continue;

      const share = totalBond > 0 ? bond / totalBond : 0;
      const isOperator = lower(node.node_operator_address) === address;
      // The operator fee comes off the whole award before the pro-rata split.
      const netAward = isOperator
        ? award * (fee + (1 - fee) * share)
        : award * share * (1 - fee);
      const { apr, apy } = estimateCurrentChurnYields({ reward: netAward, principal: bond, ...estimate });

      rows.push({
        key: `${address}:${node.node_address}`,
        address,
        nodeAddress: node.node_address,
        operatorAddress: node.node_operator_address || '',
        isOperator,
        status: node.status || '',
        bond: units(bond),
        bondUsd: units(bond) * num(runePriceUsd),
        share,
        operatorFee: fee,
        bondYield: readBondYieldConfig(provider),
        pendingReward: units(netAward),
        pendingRewardUsd: units(netAward) * num(runePriceUsd),
        apr: Number.isFinite(apr) ? apr : 0,
        apy: Number.isFinite(apy) ? apy : 0,
        requestedToLeave: !!node.requested_to_leave,
        forcedToLeave: !!node.forced_to_leave,
        slashPoints: num(node.slash_points),
        leave: typeof getLeave === 'function' ? getLeave(node, nodes) : null
      });
    }
  }

  return rows.sort((a, b) => b.bond - a.bond);
}

// ============================================
// Liquidity
// ============================================

export function lpType(runeAddress, assetAddress) {
  if (runeAddress && assetAddress) return 'sym';
  if (runeAddress) return 'rune';
  return 'asset';
}

/**
 * Merge Midgard member pools with THORNode liquidity_provider lookups.
 * `providers` maps `${pool}|${lookupAddress}` → THORNode LP payload.
 */
export function buildLpRows({ memberPools, providers = {}, addresses, prices = {} }) {
  const tracked = new Set((addresses || []).map(lower));
  const runePrice = num(prices['THOR.RUNE']);
  const rows = [];
  const seen = new Set();

  for (const member of Array.isArray(memberPools) ? memberPools : []) {
    if (num(member?.liquidityUnits) <= 0 && num(member?.runePending) <= 0 && num(member?.assetPending) <= 0) continue;
    const pool = member.pool;
    const runeAddress = member.runeAddress || '';
    const assetAddress = member.assetAddress || '';
    const key = `${pool}|${lower(runeAddress)}|${lower(assetAddress)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const owner = tracked.has(lower(runeAddress)) ? runeAddress : assetAddress;
    const lookup = runeAddress || assetAddress;
    const live = providers[`${pool}|${lookup}`] || null;
    const assetPrice = num(prices[pool]);

    const runeRedeem = live ? units(live.rune_redeem_value) : 0;
    const assetRedeem = live ? units(live.asset_redeem_value) : 0;
    const runeDeposit = live ? units(live.rune_deposit_value) : units(member.runeDeposit);
    const assetDeposit = live ? units(live.asset_deposit_value) : units(member.assetDeposit);
    const valueUsd = runeRedeem * runePrice + assetRedeem * assetPrice;
    const depositUsd = runeDeposit * runePrice + assetDeposit * assetPrice;

    rows.push({
      key,
      pool,
      owner,
      runeAddress,
      assetAddress,
      type: lpType(runeAddress, assetAddress),
      units: num(member.liquidityUnits),
      runeRedeem,
      assetRedeem,
      runeDeposit,
      assetDeposit,
      runePending: units(member.runePending),
      assetPending: units(member.assetPending),
      runeAdded: units(member.runeAdded),
      assetAdded: units(member.assetAdded),
      runeWithdrawn: units(member.runeWithdrawn),
      assetWithdrawn: units(member.assetWithdrawn),
      valueUsd,
      depositUsd,
      gainUsd: live ? valueUsd - depositUsd : 0,
      luviGrowthPct: live ? num(live.luvi_growth_pct) * 100 : 0,
      firstAdded: num(member.dateFirstAdded),
      lastAdded: num(member.dateLastAdded),
      hasLiveValue: !!live
    });
  }

  return rows.sort((a, b) => b.valueUsd - a.valueUsd);
}

// ============================================
// TCY
// ============================================

/**
 * `stakers`: address → { amount } (base units), `balances`: address → TCY
 * base units in the wallet, `distributions`: address → Midgard payload,
 * `claims`: array of { l1_address, asset, amount } (base units).
 */
export function buildTcyRows({ addresses, stakers = {}, balances = {}, distributions = {}, tcyPriceUsd = 0, runePriceUsd = 0 }) {
  const rows = [];
  for (const address of addresses || []) {
    const staked = units(stakers[address]?.amount);
    const liquid = units(balances[address]);
    const payload = distributions[address] || {};
    const payouts = (payload.distributions || [])
      .map((entry) => {
        const rune = units(entry.amount);
        const priceAtPayout = entry.price ? units(entry.price) : num(runePriceUsd);
        return { date: num(entry.date), rune, usdAtPayout: rune * priceAtPayout, usdNow: rune * num(runePriceUsd) };
      })
      .sort((a, b) => b.date - a.date);
    const totalRune = payouts.reduce((sum, entry) => sum + entry.rune, 0);

    if (staked <= 0 && liquid <= 0 && payouts.length === 0) continue;
    rows.push({
      address,
      staked,
      liquid,
      stakedUsd: staked * num(tcyPriceUsd),
      liquidUsd: liquid * num(tcyPriceUsd),
      apr: num(payload.apr) * 100,
      payouts,
      totalPayoutRune: totalRune,
      totalPayoutUsdAtPayout: payouts.reduce((sum, entry) => sum + entry.usdAtPayout, 0),
      totalPayoutUsdNow: totalRune * num(runePriceUsd),
      lastPayout: payouts[0] || null
    });
  }
  return rows.sort((a, b) => b.stakedUsd - a.stakedUsd);
}

export function buildTcyClaimRows(claims, tcyPriceUsd = 0) {
  return (Array.isArray(claims) ? claims : [])
    .filter((claim) => num(claim?.amount) > 0)
    .map((claim) => ({
      key: `${claim.l1_address}|${claim.asset}`,
      address: claim.l1_address,
      asset: claim.asset,
      chain: String(claim.asset || '').split('.')[0],
      amount: units(claim.amount),
      valueUsd: units(claim.amount) * num(tcyPriceUsd)
    }));
}

/** Combine per-day payouts across addresses into a sorted daily series. */
export function mergePayoutSeries(tcyRows) {
  const byDay = new Map();
  for (const row of tcyRows || []) {
    for (const payout of row.payouts) {
      const day = Math.floor(payout.date / 86400) * 86400;
      const current = byDay.get(day) || { date: day, rune: 0, usdAtPayout: 0 };
      current.rune += payout.rune;
      current.usdAtPayout += payout.usdAtPayout;
      byDay.set(day, current);
    }
  }
  return [...byDay.values()].sort((a, b) => a.date - b.date);
}

// ============================================
// Native wallet holdings
// ============================================

/** Native bank balances only: bonded RUNE, LP positions and pending rewards are separate. */
export function buildRuneRows({ addresses = [], walletBalances = {}, runePriceUsd = 0 }) {
  return [...new Set(addresses.map(lower).filter(isThorAddress))].map((address) => {
    const coins = walletBalances[address]?.balances;
    const coin = Array.isArray(coins) ? coins.find((entry) => entry.denom === 'rune') : null;
    const balanceKnown = Array.isArray(coins) && (!coin || /^\d+$/.test(String(coin.amount)));
    const rune = balanceKnown ? units(coin?.amount) : null;
    return { address, rune, valueUsd: balanceKnown ? rune * num(runePriceUsd) : null, balanceKnown };
  });
}

// ============================================
// Totals
// ============================================

export function summarize({ bondRows = [], lpRows = [], tcyRows = [], claimRows = [], runeRows = [] }) {
  const bondUsd = bondRows.reduce((sum, row) => sum + row.bondUsd, 0);
  const lpUsd = lpRows.reduce((sum, row) => sum + row.valueUsd, 0);
  const tcyUsd = tcyRows.reduce((sum, row) => sum + row.stakedUsd + row.liquidUsd, 0);
  const runeUsd = runeRows.reduce((sum, row) => sum + num(row.valueUsd), 0);
  return {
    runeUsd,
    runeHeld: runeRows.reduce((sum, row) => sum + num(row.rune), 0),
    runeBalanceMissing: runeRows.filter((row) => !row.balanceKnown).length,
    bondUsd,
    bondRune: bondRows.reduce((sum, row) => sum + row.bond, 0),
    pendingRewardRune: bondRows.reduce((sum, row) => sum + row.pendingReward, 0),
    pendingRewardUsd: bondRows.reduce((sum, row) => sum + row.pendingRewardUsd, 0),
    lpUsd,
    lpGainUsd: lpRows.reduce((sum, row) => sum + row.gainUsd, 0),
    tcyUsd,
    tcyStaked: tcyRows.reduce((sum, row) => sum + row.staked, 0),
    tcyPayoutRune: tcyRows.reduce((sum, row) => sum + row.totalPayoutRune, 0),
    tcyPayoutUsd: tcyRows.reduce((sum, row) => sum + row.totalPayoutUsdAtPayout, 0),
    claimableTcy: claimRows.reduce((sum, row) => sum + row.amount, 0),
    totalUsd: bondUsd + lpUsd + tcyUsd + runeUsd
  };
}

/**
 * Rows owned by one tracked address ('' keeps everything). LP rows belong to
 * their `owner`, so a symmetric position counts once even when both of its
 * addresses are tracked.
 */
export function rowsFor(rows, address) {
  if (!address) return rows || [];
  const target = lower(address);
  return (rows || []).filter((row) => lower(row.owner ?? row.address) === target);
}

/** Value split per tracked address, in the order given. */
export function summarizeByAddress({ addresses = [], bondRows = [], lpRows = [], tcyRows = [], runeRows = [] }) {
  return addresses.map((address) => {
    const { bondUsd, lpUsd, tcyUsd, runeUsd, runeHeld, runeBalanceMissing, totalUsd } = summarize({
      bondRows: rowsFor(bondRows, address),
      lpRows: rowsFor(lpRows, address),
      tcyRows: rowsFor(tcyRows, address),
      runeRows: rowsFor(runeRows, address)
    });
    return { address, bondUsd, lpUsd, tcyUsd, runeUsd, runeHeld, runeBalanceMissing, totalUsd };
  });
}
