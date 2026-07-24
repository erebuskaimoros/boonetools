# BooneTools Volume Accounting

## Canonical backend rule

BooneTools backend volume is counted per executed swap leg. A swap between
RUNE and one pool asset contributes one leg. A cross-asset swap routed through
RUNE contributes two legs. Canonical API fields declare the
`executed-leg-usd` basis and use `leg_volume_usd` (or the equivalent
camel-cased field) wherever a new contract can do so.

Every aggregate, ranking, rolling average, market-share calculation, and
fee/volume denominator must use leg volume. A backend producer must not mix
route-input notional with fees collected across multiple legs.

Some source APIs expose USD values for each endpoint leg; others expose only
route-input notional plus the list of pools traversed. In the latter case,
BooneTools allocates the route notional once to each executed pool leg. The
source and derivation remain explicit in API metadata.

## Intentional presentation exceptions

A UI may show route notional when that is the clearest description of one
human-readable route, for example a table row labeled `BTC -> ETH`. That value
must be named `route volume` (or `route input`) and kept separate from
`leg volume`. It must not feed backend aggregates or fee-rate calculations.

Externally published comparison metrics such as CoinMarketCap global exchange
volume retain their provider-defined market-volume convention. BooneTools does
not recalculate those third-party values, and labels them by source rather than
presenting them as THORChain leg volume.

## Active data paths

| Surface | Canonical backend basis | Presentation-only value |
| --- | --- | --- |
| Dynamic Fee pair epochs | Selected executed pair leg | Transaction route input |
| Dynamic Fee affiliate history | Route notional allocated across `action.pools` | Raw route notional |
| Rapid Swaps summaries, rankings, and adoption | RUNE route once; cross-asset route across both legs | Explicit `route_volume_usd` on each row |
| TC Fee native income yield | Midgard executed-leg THORChain swap volume | CMC/Dune external market benchmarks |
| Limit Order market chart | Backend pool history remains executed-leg volume | Cross-pair chart intentionally displays a labeled half-sum blend |

The legacy Rapid Swaps database/API name `comparable_volume_usd` is retained
for compatibility. It is an executed-leg value; new responses also expose the
same value as `leg_volume_usd` and identify the volume basis.
