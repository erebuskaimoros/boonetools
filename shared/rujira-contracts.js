// Mainnet deployments verified from CosmWasm contract history/CW2 state.
// Keep older deployments so persisted history and late settlements stay readable.
export const RUJIRA_VS_CONTRACTS = Object.freeze([
  Object.freeze({ key: 'vs-v1-swap', label: 'VS v1 swaps', kind: 'swap',
    address: 'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g',
    deployedHeight: 22930165, syncKey: 'rujira-thorchain-swap-actions:v1' }),
  Object.freeze({ key: 'vs-v2-swap', label: 'VS v2 swaps', kind: 'swap',
    address: 'thor1prh3ue5nd4he254eyg3vq4lxvzed65afp9prv9qvdl2cwfq6xcnqah3aet',
    deployedHeight: 28519564, deployedAt: '2026-11-03T18:13:46.912Z',
    syncKey: 'rujira-thorchain-swap-actions:vs-v2-swap:v1' }),
  Object.freeze({ key: 'vs-v2-arb', label: 'VS v2 arbitrage', kind: 'arb',
    address: 'thor1g7cqgq389q738jrwnxhuah0u86t2pwnruvsdq70l7yt6egj6q9jq4kfeqf',
    deployedHeight: 28519564, deployedAt: '2026-11-03T18:13:46.912Z',
    syncKey: 'rujira-thorchain-swap-actions:vs-v2-arb:v1' })
]);
