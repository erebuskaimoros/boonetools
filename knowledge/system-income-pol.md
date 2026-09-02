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
`network.rune_price_in_tor` and the effective `POLRESERVESYSTEMINCOMEBPS` Mimir
from the shared snapshot so public USD values and the configured allocation do
not require a request-time provider call. Current ownership is LP units divided
by total `pool_units`, including synth dilution. Current holdings use the LP
endpoint's RUNE and asset redeem values; position value is separate from the
estimated swap-fee share.

Position samples time-weight ownership and now retain the reconciled SIPOL
position value in RUNE. Durable block swap fees are compacted into UTC hours and
multiplied by each hour's sampled ownership share; the open hour remains
provisional and a missing estimate remains `null`, never zero. The initial
pre-value samples are explicitly seeded from the current reconciled position
and age out as measured hours arrive.

Estimated fee APR uses only completed UTC hours. For each 24-hour, 7-day, and
30-day window it divides total attributed fees by total average SIPOL
position-value hours, then multiplies the hourly rate by 8,760 without
compounding. The read model reports available, covered, measured, and seeded
hours so the frontend can distinguish warming, partial, seeded, and complete
windows. Funding/deployment history still compacts from the durable block
ledger, not the retention-pruned header overlay.

The five headlines are current POL TVL in USD, total RUNE deposited, estimated
fees in USD with its 24-hour estimated fee APR, the current
`POLRESERVESYSTEMINCOMEBPS` allocation, and current RUNE
held (the dashboard's quoted “burned” measure) as a share of all system income
since activation. The
asset inventory lists the reconciled RUNE and external asset legs separately.

The public handler is provider-free: it reads `system-income-pol:v1` and
overlays committed blocks newer than the model watermark. The frontend applies
each SSE height once and shows independent event, position, and fee freshness.

## Historical deposit dollars

The deposit chart's USD mode multiplies each UTC day's deployed RUNE by that
day's historical `runePriceUSD` already stored in `system_income_burn_daily`.
Midgard earnings defines this as the deepest USD pool's **end-of-interval**
price, not a daily average. Completed days use their day-end reference; the
open day's latest interval price is provisional. The read model joins prices
by UTC date and exposes source, interval end, update time, and provisional
status without new provider requests.

The cumulative USD line sums those historically priced daily deposits across
the full history before range selection or zoom. Missing nonzero-day prices
stay unavailable and interrupt the cumulative USD total; they never fall back
to today's price. Live deposits retain the current day's supplied reference,
while a new UTC day waits for its own price. Headline LP TVL and current
holdings continue to use the latest RUNE price.

Source contract: [Midgard earnings schema](https://gitlab.com/thorchain/midgard/-/blob/develop/openapi/openapi.yaml).
