# THORChain Status Dashboard

The BooneTools `/status` dashboard is a concise public current-state surface. It intentionally keeps live protocol state separate from historical vote ingestion so one source failing does not blank the other.

## Current-State Sources

- `/thorchain/inbound_addresses`: per-chain trading and LP-action availability.
- `/thorchain/lastblock`: THORChain height and each external chain's last observed height.
- `/thorchain/nodes`: active-node count and majority active version.
- `/thorchain/mimir`: asset-specific `PauseLPDeposit-*` state not represented by the chain-level LP flag.
- Midgard `/v2/churns`: latest successful churn height and timestamp.

The chain table presents one `LP Actions` state. `chain_lp_actions_paused` blocks both adds and withdrawals. Full `Halt<chain>Chain`, solvency, global-chain, and node-pause state also blocks both actions, matching the Thornode handlers. If those flags are clear but any `PauseLPDeposit-<chain>-*` Mimir is positive, the combined chain state is `PARTIAL`.

Signing is independent of trading and LP actions. Global or per-chain `HaltSigning` values become active once their configured height is reached; a full chain halt also reports signing as paused. The top churn card applies the same height-aware rule to `HaltChurning` and shows elapsed time since Midgard's latest successful churn. If churn history is unavailable, the card estimates from the newest active-node `status_since` height without failing current chain status.

## Historical Sources

`/functions/v1/node-votes` supplies timestamped effective operational Mimir changes and current economic vote progress. The status page translates effective halt, resume, signing, and LP changes into plain language, while retaining the raw Mimir key/value and linking the transaction to `thorchain.net`.

The full explorer remains the detail surface:

- `https://thorchain.net/network`
- `https://thorchain.net/network/votes`

## Failure Behavior

THORNode current state and BooneTools vote history load independently. If vote history is unavailable, current chain availability remains visible with a scoped warning. The page refreshes every 60 seconds and supports manual refresh.
