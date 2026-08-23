# System Income Burn Tracker

`/burn-tracker` tracks only the ongoing RUNE burn controlled by
`SYSTEMINCOMEBURNRATEBPS`. It must not infer this value from `500m -
MAXRUNESUPPLY`, bank-supply changes, or generic burn events because other
protocol routes also destroy RUNE.

## Metric contract

- Canonical live amount: the `income_burn` attribute on THORChain's `rewards`
  finalize-block event. It is the route-specific amount used by the matching
  `mint_burn` event with `reason=burn_system_income`.
- Historical daily aggregate: Liquify Midgard earnings pool `income_burn`.
- Current rate: effective Mimir in BPS, divided by 100 for display percent;
  preserve a configured zero and use the compiled constant only when unset.
- Current supply: Cosmos bank total supply for denom `rune`, not circulating or
  maximum supply.
- Price: Midgard earnings `runePriceUSD` for the aligned interval.

## Runtime design

Migration `049_system_income_burn_tracker.sql` stores one row per UTC day and a
resumable sync state. Migration `050_system_income_burn_blocks.sql` stores the
exact route burn on each live `chain_block_headers` row. The consolidated
listener emits that amount with every `/chain-events` head, and the public GET
overlays committed blocks newer than the latest read-model snapshot. The
five-minute provider job revisits recent days, overrides the current interval
bucket with an unbucketed partial-day query, and reconciles the stream against
Midgard while publishing `system-income-burn:v1`.

The frontend defaults to 90 days and offers 30/90/180/all-time presets,
drag/pinch zoom, an all-time-anchored cumulative series, and an optional
RUNE/USD series. Null source gaps remain null; the current UTC day is visibly
marked partial. The navbar exposes the dashboard normally on desktop and
mobile. Base-unit values remain Postgres numerics and JSON strings, because
bank supply exceeds JavaScript's safe integer range.
