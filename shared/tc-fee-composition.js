import { isStablecoin } from './blockchain.js';

export const TC_FEE_BUCKETS = ['btc', 'eth', 'stablecoins', 'other'];

export function tcFeePoolBucket(asset) {
  const pool = String(asset || '').trim().toUpperCase();
  if (pool === 'BTC.BTC') return 'btc';
  if (pool === 'ETH.ETH') return 'eth';
  return isStablecoin(pool) ? 'stablecoins' : 'other';
}

function runeBase(value) {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(String(value ?? ''));
  return match ? BigInt(match[1]) * 100000000n + BigInt((match[2] || '').padEnd(8, '0')) : null;
}

/** Reconcile every pool before assigning shares; missing fees are never "other". */
export function reconcileTcPoolFees(pools, totalRune, totalUsd) {
  const expected = runeBase(totalRune);
  if (!Array.isArray(pools) || expected === null || totalUsd == null || !Number.isFinite(Number(totalUsd)) || Number(totalUsd) < 0) return null;
  const amounts = Object.fromEntries(TC_FEE_BUCKETS.map(id => [id, 0n]));
  const seen = new Set();
  for (const row of pools) {
    if (!row || typeof row !== 'object') return null;
    const asset = String(row.pool || '').trim().toUpperCase();
    const raw = String(row.totalLiquidityFeesRune ?? '');
    if (!/^\d+$/.test(raw) || row.partial) return null;
    const value = BigInt(raw);
    // Midgard also emits reward-only pseudo-pools, which cannot contribute fees.
    if (!/^[A-Z0-9]+\.[A-Z0-9._:-]+$/.test(asset)) {
      if (value !== 0n) return null;
      continue;
    }
    if (seen.has(asset)) return null;
    seen.add(asset);
    amounts[tcFeePoolBucket(asset)] += value;
  }
  const total = Object.values(amounts).reduce((sum, value) => sum + value, 0n);
  const difference = total > expected ? total - expected : expected - total;
  // Allow at most one base unit per pool for decimal transport/rounding, not a
  // percentage-sized shortfall that could conceal a retired or missing pool.
  if (difference > BigInt(seen.size) || (expected === 0n) !== (total === 0n)) return null;
  if ((total === 0n) !== (Number(totalUsd) === 0)) return null;
  return Object.fromEntries(TC_FEE_BUCKETS.map(id => [id,
    total === 0n ? 0 : Number(amounts[id]) / Number(total) * Number(totalUsd)
  ]));
}
