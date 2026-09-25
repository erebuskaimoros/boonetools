# TC Fee Dash

`/tc-fee-dash` combines the persisted TC fee-capture time series with a live
system-income allocation panel. The historical charts remain backed by the
`tc-fee-dash:v1` public read model.

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
entirely a bond-provider allocation. The September 25 implementation on
`feat/shared-echarts-time-series` is local, not deployed.

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
