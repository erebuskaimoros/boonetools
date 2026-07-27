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

Signing is independent of trading and LP actions. Global or per-chain `HaltSigning` values become active once their configured height is reached; a full chain halt also reports signing as paused. The top churn card applies the same height-aware rule to `HaltChurning` and shows elapsed time since Midgard's latest successful churn. If churn history is unavailable, the card estimates from the newest active-node `status_since` height without failing current chain status.

The Stuck Transactions section is intentionally narrower than a pending-transaction list. It includes only finalized user obligations that have no matching completed outbound and have exceeded the live protocol window while the relevant operation is enabled. Outbound signing uses the original transaction's scheduled height—not the rolling retry height—and the current `SigningTransactionPeriod + ObservationDelayFlexibility`. Completed sibling outbounds are matched individually so one successful payment cannot hide another unpaid obligation. Active limit orders, progressing streams, calculated security delays, and transactions explained by current trading, streaming, signing, full-chain, or solvency halts are excluded.

The backend bounds per-transaction lookup concurrency, persists lookups by
queue fingerprint, and exposes partial-scan metadata if individual lookups
fail. This prevents both browsers and successive scheduler processes from
querying THORNode once per unchanged queued transaction.

## Historical Sources

`/functions/v1/node-votes` supplies timestamped effective operational Mimir changes and current economic vote progress. The status page translates effective halt, resume, signing, and LP changes into plain language, while retaining the raw Mimir key/value and linking the transaction to `thorchain.net`.

Block-production history is part of the materialized status read model rather
than a browser-side provider call. The status scheduler samples canonical
THORChain RPC block-header timestamps, bootstraps the last 24 hours with hourly
20-block windows, and then appends five-minute live averages. Samples are
retained for 48 hours in `block_production_samples`; the public contract
downsamples to at most 150 points while preserving the full 24-hour span. A
block-header failure leaves the rest of the status dashboard usable and gives
the chart its own warning/collection state.

Short historical gaps can be replaced with canonical five-minute buckets by
running `node src/backfill-block-production.js <start-height> <end-height>` in
the backend runtime. The backfill fetches every header in bounded 20-block RPC
pages, rejects incomplete ranges, and removes overlapping hourly bootstrap
samples before inserting the non-overlapping five-minute series.

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
