/**
 * Churn-by-churn bond history for the Position Tracker. Per-address rows
 * follow the classic Bond Tracker's decomposition (BondTrackerV2.svelte), so
 * a single address reads the same in both tools; several addresses merge into
 * one portfolio series by churn height.
 */

import { calculateAPR, calculateAPY } from '../utils/calculations.js';

/** Stack moves smaller than 0.1 RUNE are reward rounding, not bond or unbond. */
export const BOND_EVENT_MIN = 1e7;

export const isBondEvent = (bondChange) => Math.abs(bondChange || 0) >= BOND_EVENT_MIN;

/**
 * The classic Bond Tracker's cards for one or several providers. Live bond
 * rows use whole RUNE; churn snapshots use THORChain's 1e8 base units.
 */
export function summarizeBondMetrics(rows = [], history = []) {
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const bondRune = rows.reduce((total, row) => total + number(row.bond), 0);
  const pendingRewardRune = rows.reduce((total, row) => total + number(row.pendingReward), 0);
  const weightedApr = rows.reduce((total, row) => {
    // Compound the portfolio once, after combining rewards/principal. Averaging
    // already compounded node APYs overstates yield when their rewards differ.
    // Older rows that only contain APY can recover the same daily-compounded APR.
    const rowApy = number(row.apy);
    const rowApr = row.apr != null && Number.isFinite(Number(row.apr))
      ? Number(row.apr)
      : rowApy > -1 ? 365 * Math.expm1(Math.log1p(rowApy) / 365) : 0;
    return total + number(row.bond) * rowApr;
  }, 0);
  const apr = bondRune > 0 ? weightedApr / bondRune : 0;
  const apy = number(calculateAPY(apr));
  const nodes = [...new Set(rows.map((row) => row.nodeAddress).filter(Boolean))];
  const node = nodes.length === 1 ? rows.find((row) => row.nodeAddress === nodes[0]) : null;
  const netBondChange = history.reduce((total, entry) => total + (isBondEvent(entry.bondChange) ? number(entry.bondChange) : 0), 0);
  const firstStack = number(history[0]?.runeStack);
  const totalRewards = history.length >= 2 ? number(history.at(-1).runeStack) - firstStack - netBondChange : 0;

  return {
    bondRune,
    pendingRewardRune,
    apr,
    apy,
    annualRewardRune: bondRune * apy,
    nodeCount: nodes.length,
    nodeFee: node ? number(node.operatorFee) : null,
    nodeAddress: node?.nodeAddress || '',
    totalRewardsRune: totalRewards / 1e8,
    totalRewardsUsd: history.length >= 2
      ? history.reduce((total, entry) => total + (number(entry.reward) / 1e8) * number(entry.runePrice), 0)
      : 0,
    netBondChangeRune: netBondChange / 1e8,
    rewardPercent: firstStack > 0 ? (totalRewards / firstStack) * 100 : 0
  };
}

function withYield(entry, prev, reward) {
  const apr = prev.runeStack > 0 ? calculateAPR(reward, prev.runeStack, entry.timestampSec - prev.timestampSec) : 0;
  return calculateAPY(apr);
}

/** Turn `/bond-history` rows into per-churn reward, bond change and APY. */
export function buildChurnHistory(rows) {
  const results = (rows || []).map((row) => ({
    height: row.churn_height,
    timestampSec: row.churn_timestamp,
    date: new Date(row.churn_timestamp * 1000),
    runeStack: row.rune_stack,
    userBond: row.user_bond != null ? row.user_bond : null,
    usdValue: (row.rune_stack / 1e8) * row.rune_price,
    runePrice: row.rune_price,
    ratesJson: row.rates_json || null
  }));

  return results.map((entry, index) => {
    if (index === 0) return { ...entry, earned: 0, reward: 0, bondChange: 0, apy: 0 };
    const prev = results[index - 1];
    const earned = entry.runeStack - prev.runeStack;
    // With the bond split out, reward is this churn's payout and bondChange is
    // the user's own bond/unbond (the previous stack already folded in its reward).
    let reward = earned;
    let bondChange = 0;
    if (entry.userBond != null) {
      reward = entry.runeStack - entry.userBond;
      bondChange = entry.userBond - prev.runeStack;
    }
    return { ...entry, earned, reward, bondChange, apy: withYield(entry, prev, reward) };
  });
}

/**
 * Merge per-address histories by churn height. An address keeps its last
 * snapshot between rows (histories refresh independently, so one can lag),
 * and one that starts after the first churn joins as a bond event.
 */
export function combineChurnHistories(histories) {
  const series = (histories || []).filter((rows) => rows?.length);
  if (series.length <= 1) return series[0] || [];

  const heights = [...new Set(series.flatMap((rows) => rows.map((row) => row.height)))].sort((a, b) => a - b);
  const cursors = series.map(() => -1);
  const combined = [];

  for (const height of heights) {
    let runeStack = 0;
    let reward = 0;
    let bondChange = 0;
    /** @type {ReturnType<typeof buildChurnHistory>[number] | null} */
    let sample = null;

    series.forEach((rows, seriesIndex) => {
      let index = cursors[seriesIndex];
      while (index + 1 < rows.length && rows[index + 1].height <= height) index += 1;
      cursors[seriesIndex] = index;
      if (index < 0) return;
      const row = rows[index];
      runeStack += row.runeStack;
      if (row.height !== height) return;
      sample = sample || row;
      if (index > 0) {
        reward += row.reward;
        bondChange += row.bondChange;
      } else if (height !== heights[0]) {
        bondChange += row.runeStack;
      }
    });
    if (!sample) continue; // unreachable: every height came from some address's row

    const entry = {
      height,
      timestampSec: sample.timestampSec,
      date: sample.date,
      runeStack,
      userBond: null,
      usdValue: (runeStack / 1e8) * sample.runePrice,
      runePrice: sample.runePrice,
      ratesJson: sample.ratesJson
    };
    const prev = combined[combined.length - 1];
    combined.push(prev
      ? { ...entry, earned: runeStack - prev.runeStack, reward, bondChange, apy: withYield(entry, prev, reward) }
      : { ...entry, earned: 0, reward: 0, bondChange: 0, apy: 0 });
  }
  return combined;
}

/** Union of per-address churn height → bond/unbond tx hash maps. */
export function mergeBondTxMaps(maps) {
  const merged = {};
  for (const map of maps || []) {
    for (const [height, hashes] of Object.entries(map || {})) {
      merged[height] = [...(merged[height] || []), ...hashes];
    }
  }
  return merged;
}

export function churnCsvRows(history) {
  return [...history].reverse().map((churn) => ({
    date: churn.date.toISOString().slice(0, 10),
    reward_rune: (churn.reward / 1e8).toFixed(4),
    bond_change_rune: (churn.bondChange / 1e8).toFixed(4),
    apy_pct: (churn.apy * 100).toFixed(2),
    stack_rune: (churn.runeStack / 1e8).toFixed(4),
    rune_price_usd: churn.runePrice.toFixed(4),
    usd_value: churn.usdValue.toFixed(2)
  }));
}
