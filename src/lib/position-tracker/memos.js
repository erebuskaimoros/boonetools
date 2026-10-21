/**
 * THORChain memo and transaction-plan builders for Position Tracker actions.
 *
 * Every management action becomes a plan that the UI shows for review before
 * the connected wallet signs it. Formats follow ThorNode's memo parser
 * (x/thorchain/memo): BOND, UNBOND, BONDYIELD, +, -, TCY+, TCY-, TCY.
 *
 * Plan shape:
 *   {
 *     action,           // stable action id
 *     title,            // human summary
 *     chain,            // chain whose wallet signs (THOR for MsgDeposit)
 *     asset,            // asset sent with the tx
 *     amount,           // human-readable amount sent ('0' for memo-only deposits)
 *     memo,
 *     route             // 'thor-deposit' (MsgDeposit) | 'inbound' (L1 send to vault)
 *                       // | 'inbound-dust' (minimum L1 send, sized by the signer)
 *   }
 */

import { normalizeTrackedAddress, isThorAddress } from './addresses.js';
import { bondYieldBps, bondYieldTarget, requireBondYieldAddress } from './bond-yield.js';

const BASE = 1e8;
export const MAX_BPS = 10000;

function requireThorAddress(address, label) {
  if (!isThorAddress(address)) throw new Error(`${label} must be a thor1 address`);
  return normalizeTrackedAddress(address);
}

export function parseAmount(value, label = 'Amount') {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`${label} must be a positive number`);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 8) throw new Error(`${label} supports at most 8 decimals`);
  const normalized = fraction ? `${whole}.${fraction}` : whole;
  if (Number(normalized) <= 0) throw new Error(`${label} must be greater than zero`);
  return normalized.replace(/^0+(?=\d)/, '');
}

/** Exact human amount → base-unit (1e8) integer string. */
export function toBaseUnits(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  const digits = `${whole}${fraction.padEnd(8, '0')}`.replace(/^0+(?=\d)/, '');
  return digits || '0';
}

export function percentToBps(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error('Percentage must be between 0 and 100');
  }
  return Math.max(1, Math.min(MAX_BPS, Math.round(value * 100)));
}

// ============================================
// Bond
// ============================================

export function planBond({ nodeAddress, amount }) {
  const node = requireThorAddress(nodeAddress, 'Node address');
  const value = parseAmount(amount, 'Bond amount');
  return {
    action: 'bond',
    title: `Bond ${value} RUNE to node …${node.slice(-4)}`,
    chain: 'THOR',
    asset: 'THOR.RUNE',
    amount: value,
    memo: `BOND:${node}`,
    route: 'thor-deposit'
  };
}

export function planBondYield({ nodeAddress, percent, payoutTarget = '' }) {
  const node = requireBondYieldAddress(nodeAddress, 'Node address');
  const bps = bondYieldBps(percent);
  const target = bps === 0 ? '' : bondYieldTarget(payoutTarget);
  return {
    action: 'bond-yield',
    title: bps ? `Pay out ${bps / 100}% of future rewards from node …${node.slice(-4)}` : `Rebond all future rewards on node …${node.slice(-4)}`,
    chain: 'THOR', asset: 'THOR.RUNE', amount: '0',
    memo: `BONDYIELD:${node}:${bps}${target ? `:${target}` : ''}`,
    route: 'thor-deposit',
    nodeAddress: node, bps, payoutTarget: target
  };
}

export function planUnbond({ nodeAddress, amount }) {
  const node = requireThorAddress(nodeAddress, 'Node address');
  const value = parseAmount(amount, 'Unbond amount');
  return {
    action: 'unbond',
    title: `Unbond ${value} RUNE from node …${node.slice(-4)}`,
    chain: 'THOR',
    asset: 'THOR.RUNE',
    amount: '0',
    memo: `UNBOND:${node}:${toBaseUnits(value)}`,
    route: 'thor-deposit'
  };
}

// ============================================
// Liquidity
// ============================================

function requirePool(pool) {
  const value = String(pool ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]+\.[A-Z0-9-]+$/.test(value)) throw new Error('Pool must look like CHAIN.ASSET');
  return value;
}

/**
 * Add the RUNE side of a position. With pairedAddress the deposit is
 * symmetric (the asset side must follow from that address); without it the
 * deposit is RUNE-only asymmetric.
 */
export function planAddLiquidityRune({ pool, amount, pairedAddress = '' }) {
  const asset = requirePool(pool);
  const value = parseAmount(amount, 'RUNE amount');
  const paired = String(pairedAddress ?? '').trim();
  return {
    action: 'lp-add-rune',
    title: `Add ${value} RUNE to ${asset}${paired ? ' (symmetric)' : ''}`,
    chain: 'THOR',
    asset: 'THOR.RUNE',
    amount: value,
    memo: paired ? `+:${asset}:${paired}` : `+:${asset}`,
    route: 'thor-deposit'
  };
}

/**
 * Add the asset side of a position from its L1 chain. With pairedThorAddress
 * the deposit pairs with that RUNE address.
 */
export function planAddLiquidityAsset({ pool, amount, pairedThorAddress = '' }) {
  const asset = requirePool(pool);
  const value = parseAmount(amount, 'Asset amount');
  const paired = pairedThorAddress ? requireThorAddress(pairedThorAddress, 'Paired RUNE address') : '';
  return {
    action: 'lp-add-asset',
    title: `Add ${value} ${asset} to ${asset}${paired ? ' (symmetric)' : ''}`,
    chain: asset.split('.')[0],
    asset,
    amount: value,
    memo: paired ? `+:${asset}:${paired}` : `+:${asset}`,
    route: 'inbound'
  };
}

/**
 * Withdraw a share of a position. `side` is which address signs:
 * 'rune' for symmetric or RUNE-asym positions, 'asset' for asset-only
 * positions (signed on the asset chain with a dust send). `target` optionally
 * forces the payout into 'rune' or 'asset' only.
 */
export function planWithdrawLiquidity({ pool, percent, side = 'rune', target = '' }) {
  const asset = requirePool(pool);
  const bps = percentToBps(percent);
  const targetAsset = target === 'rune' ? 'THOR.RUNE' : target === 'asset' ? asset : '';
  const memo = `-:${asset}:${bps}${targetAsset ? `:${targetAsset}` : ''}`;
  const fromAsset = side === 'asset';
  return {
    action: 'lp-withdraw',
    title: `Withdraw ${bps / 100}% of ${asset}`,
    chain: fromAsset ? asset.split('.')[0] : 'THOR',
    asset: fromAsset ? asset : 'THOR.RUNE',
    amount: '0',
    memo,
    route: fromAsset ? 'inbound-dust' : 'thor-deposit'
  };
}

// ============================================
// TCY
// ============================================

export function planStakeTcy({ amount }) {
  const value = parseAmount(amount, 'TCY amount');
  return {
    action: 'tcy-stake',
    title: `Stake ${value} TCY`,
    chain: 'THOR',
    asset: 'THOR.TCY',
    amount: value,
    memo: 'TCY+',
    route: 'thor-deposit'
  };
}

export function planUnstakeTcy({ percent }) {
  const bps = percentToBps(percent);
  return {
    action: 'tcy-unstake',
    title: `Unstake ${bps / 100}% of staked TCY`,
    chain: 'THOR',
    asset: 'THOR.RUNE',
    amount: '0',
    memo: `TCY-:${bps}`,
    route: 'thor-deposit'
  };
}

/** Claim TCY owed to an L1 address; the L1 wallet signs a dust send. */
export function planClaimTcy({ chain, thorAddress }) {
  const destination = requireThorAddress(thorAddress, 'TCY destination');
  const sourceChain = String(chain ?? '').trim().toUpperCase();
  if (!sourceChain) throw new Error('Claim chain is required');
  return {
    action: 'tcy-claim',
    title: `Claim TCY from ${sourceChain} to …${destination.slice(-4)}`,
    chain: sourceChain,
    asset: sourceChain === 'THOR' ? 'THOR.RUNE' : '',
    amount: '0',
    memo: `TCY:${destination}`,
    route: sourceChain === 'THOR' ? 'thor-deposit' : 'inbound-dust'
  };
}

export function baseUnitsToAmount(baseUnits) {
  return Number(baseUnits || 0) / BASE;
}
