# POL Tracker

## Product contract

`/pol-tracker` begins at 2025-02-01 and samples the latest finalized THORChain
block at or before each completed UTC day end. It tracks:

- Savers depth valued in same-height TOR/USD.
- Synth-unit backing: `2 * balance_asset * asset_price * synth_units / pool_units`.
- The locked Treasury module `...6r2p` LP asset and RUNE redeemable legs.
- Gross legacy Reserve-module LP value from `runepool.pol.value`.
- Only the Reserve-owned RUNEPool economic share from `runepool.reserve.value`.

Provider-owned RUNEPool value is not a dashboard series or public API field.
It is stored only as a private reconciliation input. Gross Reserve POL and the
Reserve-owned RUNEPool share overlap; Savers and synth backing also overlap.
The dashboard therefore has no grand-total metric.

## Data contract

Every input for a day is fetched with the same `height` parameter. Missing
prices or failed Treasury LP lookups null the affected aggregate instead of
creating a partial sum. Missing dates are explicit null chart gaps. Migration
`046_pol_tracker.sql` owns daily rows, per-pool audit inputs, and resumable sync
state. The daily timer revisits seven recent days; the manual backfill fills all
missing or partial dates from February 2025.
