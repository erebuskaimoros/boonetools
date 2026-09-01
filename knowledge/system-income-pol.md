# System Income POL

`/pol-tracker` tracks the `pol_reserve` module introduced for System Income
POL. It must not read `/thorchain/pol`, the legacy Reserve-module LP position,
or the `pol_tracker_*` tables used by `/pol-tvl`.

## Exact flows

- `rewards.pol_reserve_reward` is the exact RUNE transferred into the module.
- Total distributable system income is reconstructed from the same finalized
  `rewards` event by summing bond, pool, development, burn, TCY, marketing,
  and POL allocations. This is the denominator for both headline percentages.
- `pol_reserve_deploy.pool` and `rune_amount` are the canonical deployment
  cash flow.
- The paired internal `add_liquidity` event supplies minted LP units. Its
  zero transaction ID is valid and must not be treated as an external add.
- The protocol runs swaps before the EndBlock POL deployment, so units minted
  at height H begin participating in fees at H+1.

The consolidated chain listener writes these events idempotently to the
durable `system_income_pol_blocks` ledger and to the 48-hour block-header live
overlay. `/chain-events` publishes compact reward and deployment fields for
the browser. An RPC repair cursor scans every height from activation so a
reward-only or missed block remains distinguishable from an observed zero.

## Reconciled state

`boonetools-system-income-pol.timer` runs every two minutes. It consumes the
shared `thornode-core:v1` pools, then performs only the feature-specific module
balance and deposited-pool LP lookups. It also captures
`network.rune_price_in_tor` from the shared snapshot so public USD values do
not require a request-time provider call. Current ownership is LP units divided
by total `pool_units`, including synth dilution. Current holdings use the LP
endpoint's RUNE and asset redeem values; position value is separate from the
estimated swap-fee share.

Position samples time-weight ownership. Completed and partial pool-fee totals
come from canonical `pool_analysis_daily`; the headline sums known estimates
and explicitly marks incomplete coverage, while a pool-day with no estimate
remains `null`, never zero. Funding/deployment history compacts from the durable block
ledger, not the retention-pruned header overlay.

The five headlines are current POL TVL in USD, total RUNE deposited, estimated
fees in USD, POL's share of system income, and current RUNE held (the dashboard's
quoted “burned” measure) as a share of all system income since activation. The
asset inventory lists the reconciled RUNE and external asset legs separately.

The public handler is provider-free: it reads `system-income-pol:v1` and
overlays committed blocks newer than the model watermark. The frontend applies
each SSE height once and shows independent event, position, and fee freshness.
