import { BALANCE_TTL_MS, mapLimit } from './common.js';
import { EVM_CHAINS, collectEvm } from './evm.js';
import { NATIVE_ASSETS, collectAddress } from './chains.js';

/** Independent L1 observations. No THORNode/Midgard balance reads occur here. */
export async function collectVaultBalances(rawVaults, pools = [], options = {}) {
  const startedAt = options.now ?? Date.now();
  const signal = AbortSignal.any([AbortSignal.timeout(options.budgetMs ?? 40_000), ...(options.signal ? [options.signal] : [])]);
  const settings = { ...options, signal };
  const vaults = rawVaults.map(vault => ({
    ...vault,
    coins: (vault.coins || []).map(coin => ({ ...coin, thornode_amount: coin.amount, balance_status: 'unsupported' }))
  }));
  const routerChecks = [];
  const jobs = Object.keys(EVM_CHAINS).map(chain => async () => {
    routerChecks.push(...await collectEvm(chain, vaults, pools, settings));
  });
  // Per-chain serial address work avoids burst limits on explorer free tiers.
  for (const chain of Object.keys(NATIVE_ASSETS)) {
    jobs.push(async () => {
      for (const vault of vaults) {
        const address = vault.addresses?.find(a => a.chain === chain)?.address;
        if (address) await collectAddress(chain, vault, address, settings);
      }
    });
  }
  await mapLimit(jobs, 6, job => job());
  return {
    vaults,
    routerChecks: routerChecks.sort((a, b) => `${a.chain}:${a.asset}:${a.router}`.localeCompare(`${b.chain}:${b.asset}:${b.router}`)),
    observed_at: new Date(startedAt).toISOString(),
    expires_at: new Date(startedAt + BALANCE_TTL_MS).toISOString()
  };
}
