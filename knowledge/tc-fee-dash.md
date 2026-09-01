# TC Fee Dash

`/tc-fee-dash` combines the persisted TC fee-capture time series with a live
system-income allocation panel. The historical charts remain backed by the
`tc-fee-dash:v1` public read model.

The distribution cards read `/thorchain/mimir` and `/thorchain/constants`
through BooneTools' shared `thornode-core:v1` browser adapter. The adapter is
same-origin and provider-free in normal operation, with the established
Liquify fallback retained for interactive continuity.

Five system-income lanes resolve an active Mimir before their compiled default:

- `SYSTEMINCOMEBURNRATEBPS` / `SystemIncomeBurnRateBps`
- `DEVFUNDSYSTEMINCOMEBPS` / `DevFundSystemIncomeBps`
- `TCYSTAKESYSTEMINCOMEBPS` / `TCYStakeSystemIncomeBps`
- `MARKETINGFUNDSYSTEMINCOMEBPS` / `MarketingFundSystemIncomeBps`
- `POLRESERVESYSTEMINCOMEBPS` / `POLReserveSystemIncomeBps`

The displayed Bond Providers lane is not another allocation Mimir. The
dashboard derives it as `max(0, 10,000 - explicit allocation BPS)` and warns if
the explicit total exceeds 10,000 BPS. The left card exposes each effective
source; the right card renders the same current split as a terminal-styled
Sankey flow.
