# THORChain Status Dashboard

The BooneTools `/status` dashboard is a concise public current-state surface. It intentionally keeps live protocol state separate from historical vote ingestion so one source failing does not blank the other.

## Current-State Sources

- `/functions/v1/network-snapshot`: a provider-free view of the durable
  mixed-cadence THORNode core model. Height refreshes every 15 seconds while
  slower state such as nodes, pools, constants, and churns is reused between
  refreshes.
- `/functions/v1/stuck-transactions`: BooneTools composition of current swap,
  streaming, scheduled-outbound, and signing queues. Current protocol state
  comes from the core snapshot and unchanged per-transaction status/details
  are reused from Postgres.

The chain table presents one `LP Actions` state. `chain_lp_actions_paused` blocks both adds and withdrawals. Full `Halt<chain>Chain`, solvency, global-chain, and node-pause state also blocks both actions, matching the Thornode handlers. If those flags are clear but any `PauseLPDeposit-<chain>-*` Mimir is positive, the combined chain state is `PARTIAL`.

`Avg Blocks Behind Tip` is computed from the active validator set and the
compact Bifrost scanner-health snapshot. For each connected chain, the table
shows the mean non-negative `scanner_height_diff` across validators that are
currently Active in `/thorchain/nodes`; the displayed tip is the highest valid
scanner `chain_height`. Standby validators and missing, invalid, or negative
scanner reports are excluded without falling back to the transaction-driven
`observe_chains` height. The scanner aggregate refreshes every five minutes,
stores only the fields needed for this calculation, and reuses its last good
snapshot with a scoped warning when the provider is unavailable.

Signing is independent of trading and LP actions. Global or per-chain `HaltSigning` values become active once their configured height is reached; a full chain halt also reports signing as paused. The top churn card applies the same height-aware rule to `HaltChurning`, shows elapsed time since Midgard's latest successful churn, and counts down each second to Midgard `/network`'s `nextChurnHeight` using the six-second target block interval. It reports `CHURNING` while the existing `/thorchain/network` snapshot has `vaults_migrating=true`, meaning retiring vaults are still moving funds to the new active vaults, and exposes `https://churn.thorchain.org/` only for that active migration. The Thornode and Midgard network fields reuse their two-minute core snapshots rather than adding status-page provider requests. If the Midgard target is unavailable, a future last-churn-plus-`CHURNINTERVAL` target is labeled estimated; stale past targets are not presented as a live countdown. If churn history is unavailable, the card estimates from the newest active-node `status_since` height without failing current chain status.

The Stuck Transactions section is intentionally narrower than a pending-transaction list. It includes only finalized user obligations that have no matching completed outbound and have exceeded the live protocol window while the relevant operation is enabled. Outbound signing uses the original transaction's scheduled height—not the rolling retry height—and the current `SigningTransactionPeriod + ObservationDelayFlexibility`. Completed sibling outbounds are matched individually so one successful payment cannot hide another unpaid obligation. Active limit orders, progressing streams, calculated security delays, and transactions explained by current trading, streaming, signing, full-chain, or solvency halts are excluded.

The status card groups these obligations by destination chain, ordered by the
most overdue transaction in each group. Each chain summary shows its active
count, affected stages, and maximum overdue age; the native disclosure expands
to the full transaction table and explorer links without changing the backend
payload.

The backend bounds per-transaction lookup concurrency, persists lookups by
queue fingerprint, and exposes partial-scan metadata if individual lookups
fail. This prevents both browsers and successive scheduler processes from
querying THORNode once per unchanged queued transaction.

## Historical Sources

`/functions/v1/node-votes` supplies timestamped effective operational Mimir changes and current economic vote progress. The status page translates effective halt, resume, signing, and LP changes into plain language, while retaining the raw Mimir key/value and linking the transaction to `thorchain.net`.

Block intervals come from the durable consolidated chain stream rather than a
browser-side provider call or a one-minute status-job RPC poll. Every Liquify
`NewBlock` header is stored by height in `chain_block_headers`; the interval at
height `H` is its timestamp minus `H - 1`. Raw headers are retained for 48
hours. The listener bootstraps roughly 24 hours and repairs missing heights in
bounded RPC pages every five minutes.

The chart initially replays up to 24 hours from
`/functions/v1/block-production`, then appends committed heads from the
same-origin `/functions/v1/chain-events` stream and incrementally reconciles
after its latest height. It renders the roughly 14,400 daily points as one SVG
path plus one active marker, so every block remains hoverable and zoomable
without a DOM node per sample. The one-minute status read model keeps a bounded
five-minute rollup as a fallback while the raw header lane warms up.

The legacy `backfill-block-production.js` command remains available for the old
five-minute sample table. Normal raw-header recovery is automatic and keyed by
missing height; it does not interpolate or summarize across a gap.

The full explorer remains the detail surface:

- `https://thorchain.net/network`
- `https://thorchain.net/network/votes`

## Failure Behavior

The core network snapshot, BooneTools stuck-transaction scan, and BooneTools
vote history load independently. A churn-only failure keeps healthy THORNode
state; a provider-total THORNode failure marks the core stale and leaves all
downstream publishers on their prior last-good models. A stuck-scan or
vote-history failure leaves current chain availability visible with a scoped
warning. The page refreshes every 60 seconds.
