# Pool Analysis

`/pool-analysis` consolidates pool liquidity, executed pool-leg volume, and
pool-generated liquidity fees. It does not model subsequent system-income
distribution. The dashboard is visible in navigation.

## Chart contract

- Volume and fee bars use per-pool Midgard swap-history daily totals.
- The green line defaults to cumulative generated fees. The Depth /
  Cumulative fees control switches that single line without rebuilding the
  chart or losing a custom zoom. Both modes support 30D and ALL TIME.
- Historical depth is **two-sided USD pool-accounted liquidity**, not a vault
  inventory audit: `2 × assetDepth / 1e8 × assetPriceUSD` from the same Midgard
  `/history/depths/{pool}` daily closing interval. Its asset price is the
  pool-implied USD price, so this equals twice the RUNE balance at the matching
  RUNE/USD price. Do not value past depth at today's price.
- Depth is a point-in-time closing value, not a daily sum or average. The
  current UTC day's observation is partial. Raw asset and RUNE balances plus
  the price and observation time are retained independently of volume/fees.
- Missing observations/prices remain null and break the line. API coverage
  separately identifies missing depth days. Zero is valid for an explicitly
  empty pool, not for a missing quote.
- Tooltips retain the daily generated-fees / volume rate in basis points and
  show the active line's USD value. Fee rates use matching RUNE amounts.

## Storage and operations

Migration 059 adds `pool_analysis_depth_daily`. The existing fifteen-minute
Pool Analysis job refreshes the recent 35-day window for swaps and depth;
`pool-analysis-backfill` fills history from 2021-04-01. Depth acquisition is
independent of successful fee writes, with its own error/stat fields. Public
GETs only join stored data and never fetch providers. See
[backend deployment](../docs/boonetools-backend-hetzner.md) for backfill commands.
