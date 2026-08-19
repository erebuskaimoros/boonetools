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
prices or failed Treasury LP lookups null the affected aggregate instead of
creating a partial sum. Missing dates are explicit null chart gaps. Migration
`046_pol_tracker.sql` owns daily rows, per-pool audit inputs, and resumable sync
state. The daily timer revisits seven recent days; the manual backfill fills all
missing or partial dates from February 2025.
