/** Reward-pool amounts are THORChain base units, never USD or whole RUNE. */
function amount(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

export function currentChurnRewardFraction(context, churnState) {
  if (!context || !Number.isSafeInteger(context.lastChurnHeight)
    || context.lastChurnHeight <= 0 || context.lastChurnHeight !== Number(churnState?.lastChurnHeight)) return null;
  const current = amount(context.currentBondRewardRune);
  const carryover = amount(context.carryoverBondRewardRune);
  if (current === null || carryover === null) return null;
  if (current < carryover) return null;
  if (current === carryover) return 0;
  const fraction = Number(current - carryover) / Number(current);
  return Number.isFinite(fraction) ? fraction : null;
}

/** Cache only successful immutable churn snapshots; failed reads retry on refresh. */
export function createBondRewardLoader(fetchNetwork, fetchVaults) {
  const baselines = new Map();
  return async function loadBondRewardContext(churnState) {
    const lastChurnHeight = Number(churnState?.lastChurnHeight);
    const currentHeight = Number(churnState?.currentHeight);
    if (!Number.isSafeInteger(lastChurnHeight) || lastChurnHeight <= 0
      || !Number.isSafeInteger(currentHeight) || currentHeight <= lastChurnHeight) return null;
    try {
      if (!baselines.has(lastChurnHeight)) {
        const pending = Promise.resolve().then(() => fetchNetwork(lastChurnHeight)).then((network) => {
          if (amount(network?.bond_reward_rune) === null) throw new Error('Invalid churn reward baseline');
          return network.bond_reward_rune;
        });
        baselines.set(lastChurnHeight, pending);
        pending.catch(() => { if (baselines.get(lastChurnHeight) === pending) baselines.delete(lastChurnHeight); });
        // Keep a bounded cache even across long-running sessions and churns.
        if (baselines.size > 4) baselines.delete(baselines.keys().next().value);
      }
      const [carryoverBondRewardRune, current, vaults] = await Promise.all([
        baselines.get(lastChurnHeight), fetchNetwork(currentHeight), fetchVaults(currentHeight)
      ]);
      const active = Array.isArray(vaults) ? vaults.filter((vault) => vault.status === 'ActiveVault') : [];
      // The node-award query uses the active vault's status height as its clock.
      // A lagging churn index must not mix the old baseline with a new cycle.
      if (!active.length || active.some((vault) => Number(vault.status_since) !== lastChurnHeight)) return null;
      if (amount(current?.bond_reward_rune) === null) return null;
      return { lastChurnHeight, currentHeight, carryoverBondRewardRune, currentBondRewardRune: current.bond_reward_rune };
    } catch {
      return null;
    }
  };
}

/** Missing/unexposed REST height metadata cannot prove a pinned observation. */
export function heightCheckedFetch(height, report, fetchImpl = globalThis.fetch) {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const observed = response.headers.get('grpc-metadata-x-cosmos-block-height')
      ?? response.headers.get('x-cosmos-block-height');
    report(/^\d+$/.test(observed ?? '') && Number(observed) === height);
    return response;
  };
}
