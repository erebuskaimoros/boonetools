# THORChain Status Dashboard

The BooneTools `/status` dashboard is a concise public current-state surface. It intentionally keeps live protocol state separate from historical vote ingestion so one source failing does not blank the other.

## Current-State Sources

- `/thorchain/inbound_addresses`: per-chain trading and LP-action availability.
- `/thorchain/lastblock`: THORChain height and each external chain's last observed height.
- `/thorchain/nodes`: active-node count and majority active version.
- `/thorchain/mimir`: asset-specific `PauseLPDeposit-*` state not represented by the chain-level LP flag.

`chain_lp_actions_paused` blocks both adds and withdrawals. Full `Halt<chain>Chain`, solvency, global-chain, and node-pause state also blocks both actions, matching the Thornode handlers. If those flags are clear but any `PauseLPDeposit-<chain>-*` Mimir is positive, the chain's deposit state is shown as `PARTIAL` while withdrawals remain enabled.

## Historical Sources

`/functions/v1/node-votes` supplies timestamped effective operational Mimir changes and current economic vote progress. The status page translates effective halt, resume, signing, and LP changes into plain language, while retaining the raw Mimir key/value and linking the transaction to `thorchain.net`.

The full explorer remains the detail surface:

- `https://thorchain.net/network`
- `https://thorchain.net/network/votes`

## Failure Behavior

THORNode current state and BooneTools vote history load independently. If vote history is unavailable, current chain availability remains visible with a scoped warning. The page refreshes every 60 seconds and supports manual refresh.
