# POL Tracker

## Product contract

`/pol-tracker` begins at 2025-02-01 and samples the latest finalized THORChain
block at or before each completed UTC day end. It tracks:

- Synth-unit backing: `2 * balance_asset * asset_price * synth_units / pool_units`.
- The locked Treasury module `...6r2p` LP total redeemable value.
- Gross legacy Reserve-module LP value from `runepool.pol.value`.

RUNEPool provider and Reserve ownership shares are not dashboard series or
public API fields. Provider-owned RUNEPool value is stored only as a private
reconciliation input. The dashboard combines the three tracked values into one
stacked area chart. Its hover total is their arithmetic sum.

Savers value is intentionally absent from the dashboard, public API, and newly
collected rows. Migration `046_pol_tracker.sql` retains nullable legacy Saver
columns for forward-compatible rollback, but the v2 read model never selects or
publishes them.

## Data contract

Every input for a day is fetched with the same `height` parameter. Missing
prices or failed module LP lookups null the affected breakdown instead of
creating a partial sum. Missing dates are explicit null chart gaps. Migration
`046_pol_tracker.sql` owns the original daily rows, per-pool audit inputs, and
resumable sync state. Migration `047_pol_tracker_pool_breakdown.sql` adds the
legacy Reserve module and its per-pool LP units, gross RUNE value, and USD
value. Each pool uses the same round-half-up safe-share calculation as
THORNode: `2 * safeShare(reserve_lp_units, pool_units, balance_rune)`. The
per-pool RUNE values must reconcile exactly to `runepool.pol.value`; otherwise
the Reserve lane remains partial and eligible for repair. The daily timer
revisits seven recent days; the manual backfill fills all missing or partial
dates from February 2025.

RPC block retention and THORNode historical-state retention are independent.
If an RPC resolves a real day-end block that every configured historical
THORNode rejects specifically as a future height, the collector records the
day as unavailable and continues later anchors. It never substitutes another
height or persists an approximate row; unrelated provider and 5xx failures
still retry and fail normally.

The scheduled job targets the latest completed UTC day by default and treats
that end day as its liveness watermark. `POL_TRACKER_HEAD_LAG_DAYS` can still
apply an explicit archive-provider lag when needed. The job can publish
last-good history after an RPC range mismatch, but reports the current target
incomplete and lets systemd retry after 15 minutes. Older gaps do not keep the
job failing once the newest target day is complete. The public handler
independently compares the stored source day with the expected target and
expands coverage for any unpublished days, preventing a recent republish
timestamp from making old source data appear `READY` or 100% covered.
