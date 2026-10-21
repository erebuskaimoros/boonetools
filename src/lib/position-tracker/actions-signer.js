/** Signer selection for Position Tracker plans (pure, no wallet SDK). */

const EVM_CHAINS = new Set(['ETH', 'BSC', 'AVAX', 'BASE', 'ARB', 'OP', 'POL']);

/** Pick the connected account that should sign a plan. */
export function pickSigner(accounts, plan, preferredAddress = '') {
  const chain = plan.chain === 'EVM' ? null : plan.chain;
  const candidates = (accounts || []).filter((account) => (
    chain ? account.network === chain : EVM_CHAINS.has(account.network)
  ));
  const preferred = String(preferredAddress || '').toLowerCase();
  return candidates.find((account) => account.address.toLowerCase() === preferred) || candidates[0] || null;
}
