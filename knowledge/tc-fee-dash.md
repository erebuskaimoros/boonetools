# TC Fee Dash

`/tc-fee-dash` combines the persisted TC fee-capture time series with a live
system-income allocation panel. The historical charts remain backed by the
`tc-fee-dash:v1` public read model.

## Pool-fee composition

The additive `feeComposition` field uses only existing PostgreSQL caches: a
daily row's `source_json.midgard.pools` earnings list first, then the
`pool_analysis_daily.fees_rune_e8` history as a fallback. Read-model publication
does not make new Midgard requests. The existing minute analytics timer
publishes it with the other fee dashboard fields, retaining the fee model's
five-minute minimum refresh interval; browser refreshes consume the same snapshot.

Use `totalLiquidityFeesRune`, not pool earnings/rewards, block rewards or
downstream income allocations. Reconcile the entire pool list in integer RUNE
base units against the canonical daily `tc_fees_rune` before attribution. The
maximum transport-rounding tolerance is one base unit per pool. Reject partial,
missing, duplicate or invalid inputs; unaccounted fees are never assigned to
"other". Full earnings lists preserve retired pools absent from Pool Analysis.
Only fallback daily rows with `completed_at` and `partial=false` are usable.

Four mutually exclusive buckets:

- BTC: `BTC.BTC` only.
- ETH: `ETH.ETH` only.
- Stablecoins: existing shared symbol classification (`USDC`, `USDT`, `DAI`,
  `GUSD`, `LUSD`, `USDP`, `BUSD`) across all chains, including retired BNB pools.
- Other: every remaining pool, including wrapped BTC/ETH and other-chain ETH.

Allocate the canonical daily USD total proportionally to the reconciled base
units. D/W/M views, range summaries, and 7/30/90-day rolling shares divide summed
bucket USD fees by summed total USD fees, not mean daily percentages. The
chart's 0–100% scale and denominator remain fixed when categories are hidden.
Missing dates are explicit gaps; zero-fee days have undefined percentages.
Weekly/monthly buckets containing a missing day are unavailable, while summary
cards use verified days and disclose their coverage count. Partial calendar-edge
buckets are labeled and not extrapolated.

At the October 22, 2026 validation, all 295 days of 2026 reconciled. Earlier
years contain gaps because retired pools are not all retained in the daily pool
cache. Keep these gaps honest; do not fetch history from the browser or fabricate
a residual category. No schema migration, acquisition job, or backfill is needed.
Deploy backend before frontend; the additive field appears after normal read-model
publication. Unit tests cover reconciliation and grouping; a real ECharts SSR
test verifies 100% stacking and area breaks at missing days.

## System-income allocation

The distribution cards read `/thorchain/mimir`, `/thorchain/constants`,
`/thorchain/network` and `/thorchain/nodes`
through BooneTools' shared `thornode-core:v1` browser adapter. The adapter is
same-origin and provider-free in normal operation, with the established
Liquify fallback retained for interactive continuity.

Five system-income lanes resolve an active Mimir before their compiled default:

- `SYSTEMINCOMEBURNRATEBPS` / `SystemIncomeBurnRateBps`
- `DEVFUNDSYSTEMINCOMEBPS` / `DevFundSystemIncomeBps`
- `TCYSTAKESYSTEMINCOMEBPS` / `TCYStakeSystemIncomeBps`
- `MARKETINGFUNDSYSTEMINCOMEBPS` / `MarketingFundSystemIncomeBps`
- `POLRESERVESYSTEMINCOMEBPS` / `POLReserveSystemIncomeBps`

The remainder `max(0, 10,000 - explicit allocation BPS)` is split between
Bond Providers and Liquidity Providers by the incentive pendulum. It is not
entirely a bond-provider allocation. The September 25 implementation shipped
in frontend/backend release `9b80a6e`; production browser verification showed
53.68% for bond providers and 5.32% for LPs, plus 41% explicit lanes at that check.
These are live estimates, not fixed protocol percentages.

`distribution.js` mirrors THORNode v3.20.2 `getPoolShare`:

- Resolve all three Pendulum settings from Mimirs over constants.
- Sort active nodes' atomic `total_bond` values; take the highest of the bottom
  `ceil(2N/3)` as the cap. Sum capped bonds for total effective bond and sum
  the bottom group for effective security bond, from the same node roster.
- Select pool/vault assets and total-effective/security bond with the two flags,
  and scale secured assets by `PendulumAssetsBasisPoints`.
- Undersecured means zero LP share. Otherwise apply both node and pool
  adjustments, normalize their shares, then apply them only to the remainder.

Atomic values and intermediate ratios use BigInt; only the final normalized
share converts to Number. This is an indicative current-state allocation,
not a replay of individual block rounding or historical earnings. Cached
network and node fields may have different acquisition cutoffs. The UI labels
this estimate and checks shared snapshots each minute while visible.

The left table and right Sankey use one allocation model. Zero LP rewards
remain visible in the table but do not fabricate a nonzero flow. Missing bond,
liquidity, or parameter data makes the dynamic split unavailable; an incomplete
or overallocated model never renders as a complete 100% Sankey. Failed refreshes
retain last-good values with an error notice. LP rewards include all pool owners,
including protocol-owned positions; they do not duplicate the separate POL
funding allocation.

Reference: [THORChain pendulum algorithm](https://dev.thorchain.org/concepts/incentive-pendulum.html).
Tests cover the four published flag combinations, active-node hard-cap boundaries,
unsafe numeric inputs, zero overrides, undersecurity, missing data, and conservation
of the post-REVSHARE 100% base.
