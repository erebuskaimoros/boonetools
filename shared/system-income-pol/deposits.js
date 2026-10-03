// Exact per-pool flows shared by persisted snapshots and browser live replay.
// An absent breakdown is unknown, not evidence of no historical deposits.
export function mergePoolDeposits(...groups) {
  const amounts = new Map();
  for (const row of groups.flatMap(group => Array.isArray(group) ? group : [])) {
    const asset = String(row.asset || '').trim();
    const value = String(row.deployed_e8 ?? row.rune_e8 ?? row.runeE8 ?? '');
    if (!asset || !/^\d+$/.test(value)) continue;
    amounts.set(asset, (amounts.get(asset) || 0n) + BigInt(value));
  }
  return [...amounts].sort(([a], [b]) => a.localeCompare(b))
    .map(([asset, value]) => ({ asset, deployed_e8: value.toString() }));
}
