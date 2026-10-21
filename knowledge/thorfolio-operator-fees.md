# Thorfolio operator fees (October 21, 2026)

Implemented on `feat/thorfolio`; not yet deployed. Requires backend migration 071
before frontend rollout. The previous production release remains `06c98e9`.

The optional churn-table and CSV/XLS column reports operator fees paid directly
to the wallet, separately from rewards compounded into the bond. Current operator
roles or historical positive operator payouts enable the column. Focused provider
views hide it. Unknown values remain null/dash/blank export, never measured zero.
Combined histories sum exact-height payouts and never carry a payout forward.

Acquisition uses `/block_results` at the exact churn height, pairing a node's
empty-transaction `bond_reward` with its following `bond_returned`. Ordinary
unbonds and subsequent provider returns are excluded. Before attributing a
candidate payout, query the verified node at churn-1 and confirm operator identity
and nonzero fee. THORNode `BondProviders.Adjust` reserves providers[0] for the
operator, so existing v2 RPC observations remain usable despite omitting
QueryNode's explicit operator-address field. No current fee rate is applied to
past churns. Fees never change rune_stack, bond rewards, APY or fiat reward cells.

Live validation: block 28203871 contained 111 bond rewards and 105 operator payout
returns. The payout to operator …j36c was 41.01726066 RUNE; historical node ownership
was verified independently at block 28203870 using Liquify's RPC.

Shared immutable acquisition observations retain compact payouts by block. The
existing worker enriches 25 cached rows per pass without recomputing principal or
stack; bounded progress requeues without using failure attempts. Acquisition
errors retain null fees and use the queue's existing retries/cooldowns.

Validation: frontend suite 731 passed; backend suite 881 passed, 17 existing
integration skips. Additional attribution tests passed after the full run.
`npm run check`: zero errors, 56 existing warnings. Browser verified hidden column
for the original provider portfolio and visible column for the operator example.
The local browser reads production history, so its cells remain unverified until
the backend migration and enrichment are deployed.
