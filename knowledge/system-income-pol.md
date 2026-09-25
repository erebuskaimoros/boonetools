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

Repair reuses complete event headers before requesting `/block_results`.
Incomplete accounting fields still require canonical RPC enrichment. Both
header-page acquisition and ledger repairs persist successful work in bounded
chunks. A failed request stops new work and drains launched requests before
returning, so retries do not discard successes or outlive the job's database
lock. Headers are saved before ledger rows so a failed ledger write can be
retried from local event data.

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

The positions table displays `% DEEPER`: `POL share / (1 - POL share) × 100`.
It compares current pool depth with the remaining depth excluding POL's
proportional holdings, including synth dilution in total pool units. This is
a current-position comparison, not a simulation of historical prices or
trading without POL. Missing/invalid ownership and 100% ownership display as
unavailable because there is no valid finite non-POL baseline.

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

## Daily estimated fee drill-down

The estimated-fees headline is a keyboard-accessible disclosure button. It
opens a daily bar chart directly below the headline grid, initially collapsed,
with independent USD/RUNE and 30D/90D/180D/ALL controls. Bars use the read model's
daily `estimated_fees_e8` (hourly attributed fees summed across POL positions),
never cumulative fees, deployments, or APR-derived estimates.

USD bars multiply those daily RUNE fees by the matching day's stored closing
price, using the same price contract as deposit history below. The headline
continues to value total estimated RUNE fees at the current price, so summing
historically priced USD bars need not match it. Partial/open-hour estimates
and provisional prices are labeled and visually distinguished, without
extrapolating a full day. Seeded ownership is disclosed in the selected-day
tooltip. Null estimates and missing nonzero-day prices remain visible gaps;
known zero-fee days remain zero even without a price.

The September 22 shared-ECharts branch replaces the SVG rendering locally
(not yet deployed). Hover, a native keyboard-accessible day selector, or
tapping a day exposes its UTC date, fee value, coverage pool-hours (summed
across positions), USD pricing reference, and provisional/seeded status.
Pointer tooltips are confined to the chart; pinned/keyboard details use a
width-clamped in-chart box. Click/tap or choosing a day pins it; repeat tap,
Escape, an outside tap, Dismiss, or a unit/range change clears it. Missing
days carry × markers and known zeros carry — markers without fabricated
bar heights. The headline keeps its original appearance, without a view/hide
hint. See [the toolkit contract](shared-echarts-time-series.md).

This chart uses the existing payload and refresh lifecycle; opening it makes
no additional API or provider requests.

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

The shared-ECharts deposit renderer uses the same values on independent
zero-based axes. Full-history RUNE fallback totals are also prepared before
range slicing. Live refreshes and denomination changes preserve the selected
date window. Presets reset it; marquee, double-click reset and keyboard
zoom/reset buttons share the toolkit's viewport contract.

Source contract: [Midgard earnings schema](https://gitlab.com/thorchain/midgard/-/blob/develop/openapi/openapi.yaml).
