# Pool Dislocation Dashboard Scope

## Outcome

Add a BooneTools dashboard at `/pool-dislocation` that shows when a THORChain
pool price trades above or below both THORChain's oracle and a Binance spot
reference during the trailing seven days.

The production implementation uses a durable five-minute backend sampler and
provider-free public API. The original deterministic fixture remains available
only to pure presentation tests; the dashboard never falls back to it.

## Metric Contract

For each source-aligned observation:

```text
oracle dislocation %  = 100 × (THORChain pool USD price / oracle USD price - 1)
binance dislocation % = 100 × (THORChain pool USD price / Binance USD price - 1)
```

- Positive values mean the THORChain pool trades at a premium.
- Negative values mean the THORChain pool trades at a discount.
- Ranking uses the larger absolute deviation from either reference.
- `7d avg abs` is the arithmetic mean of the per-sample maximum absolute
  deviation; it is not a signed average.
- `1h`, `4h`, `1d`, `3d`, and `7d abs` apply that same calculation to exact
  trailing five-minute observations inside each labeled window.
- `time > limit` counts aligned sample intervals at or beyond the selected
  absolute threshold.
- Optional chart overlays expose signed 1h, 6h, and 1d trailing arithmetic
  means for each selected reference. A rolling value appears after the full
  window has elapsed when at least 95% of its expected five-minute slots carry
  exact source observations. Missing values are omitted rather than carried or
  interpolated, and the hover tooltip reports the contributing sample coverage.
  Windows below 95% remain explicit gaps.

## Pool and Reference Coverage

The production dashboard should enumerate every `Available` pool returned by
THORNode rather than silently limiting the table to pools supported by both
references. Each row carries independent coverage for:

1. THORChain pool price
2. THORChain oracle symbol
3. Binance market symbol

Canonical native pools and stablecoin pools can ship first. Contract assets
require an explicit, reviewed mapping because tickers are not unique across
chains. A Binance mapping is valid only when Binance directly trades that pool
asset; an underlying spot market is never substituted for a wrapped or pegged
asset. WBTC therefore uses `WBTCUSDT`, while Avalanche Wrapped SOL, BSC BTCB,
BSC pegged ETH, and BSC pegged USDC have no Binance leg. A missing or stale
reference remains visible as `N/A`; it does not remove the THORChain pool from
the dashboard.

## Production Data Path

The public page should remain provider-free and read only BooneTools' backend.
A scheduled backend job should sample the three legs together every five
minutes:

- THORChain pool: `/thorchain/pools`, using `asset_tor_price / 1e8` as the
  pool's USD/TOR price. Preserve the raw depths and status with the observation
  for auditability. Retry bounded transient failures inside the same exact
  five-minute run, bypassing a shared provider cooldown after the first
  attempt. If all live attempts fail, accept only a pool field from the
  independently persisted `thornode-core:v1` snapshot that is no more than
  three minutes old. Label that observation
  `pool_price_method=thornode-core-snapshot`; never present it as a fresh live
  provider read.
- THORChain oracle: `/thorchain/oracle/prices`, keyed by the exact configured
  oracle symbol. Normalize the live `price` field as a decimal USD value.
- Binance: one backend `bookTicker` request for the configured spot markets;
  use `(best bid + best ask) / 2` and store the bid, ask, and symbol. Do not make
  browser-side Binance calls. Local requests may be region-blocked, so the job
  must degrade per source and preserve the last good BooneTools read model.
- Trading availability: reuse the canonical `thornode-core:v1`
  `inbound_addresses` field (itself populated from
  `/thorchain/inbound_addresses`) and treat `halted`,
  `global_trading_paused`, or `chain_trading_paused` as a chain trading halt.
  A missing or stale core field degrades to unknown and never hides a pool.
  The UI defaults to hiding pools on known halted chains and lets the user
  include them with one toggle.

An observation is aligned only when source timestamps are within 30 seconds.
References older than two five-minute intervals are stale and excluded from
dislocation calculations, while their last timestamp remains visible.

## Persistence and API

Migration `031_pool_dislocation.sql` creates
`pool_dislocation_observations`. Migration
`033_pool_dislocation_provenance.sql` adds reconstruction provenance. Migration
`034_pool_dislocation_exact_binance_markets.sql` invalidates historical proxy
legs, assigns WBTC to `WBTCUSDT`, and clears the materialized summary before it
is rebuilt.

```text
observed_at, asset, pool_status,
pool_price_usd, pool_balance_rune, pool_balance_asset,
oracle_symbol, oracle_price_usd, oracle_observed_at,
binance_symbol, binance_bid_usd, binance_ask_usd, binance_observed_at,
sample_origin, thorchain_height,
pool_price_method, oracle_price_method, binance_price_method,
primary key (observed_at, asset)
```

Keep at least 30 days of five-minute observations even though the first UI is
fixed to seven days. Materialize a compact read model after each successful job
run so the public API performs no provider calls. Split the response by display
need:

- `GET /functions/v1/pool-dislocation?window=7d` returns freshness, per-source
  health, coverage counts, and per-pool current values and seven-day summary
  statistics computed from all five-minute observations.
- `GET /functions/v1/pool-dislocation-series?asset={asset}` returns the
  selected pool's exact aligned five-minute observations: up to 2,017 points
  per reference over seven days. Do not smooth, interpolate, or reduce this
  focused series.
- The summary response includes compact hourly sparklines for every pool. Each
  hourly bucket retains the maximum absolute deviation and its signed source
  values so a brief excursion is not averaged away.

Both endpoints should cap their responses to the seven-day contract and expose
nulls plus source-age metadata instead of substituting old values. The latest
table and metric values come directly from the newest aligned five-minute
observation.

## Historical Reconstruction

`boonetools-pool-dislocation-backfill.service` is an operator-triggered,
resumable one-shot job for the seven days preceding the first scheduled
observation. It resolves the latest finalized THORChain block at or before
every exact five-minute UTC boundary, then reads both `/thorchain/pools` and
`/thorchain/oracle/prices` at that same height. This preserves one THORChain
state boundary for each reconstructed point.

Binance's public Spot archive does not expose historical `bookTicker` best
bid/ask snapshots. Reconstructed points therefore use the close of the
five-minute Binance kline ending at the same UTC boundary. Those rows retain
null bid/ask fields and are explicitly labeled `historical_backfill` plus
`kline-close`; live scheduled rows remain labeled `scheduled` plus
`book-ticker-mid`. Scheduled rows win any primary-key conflict.

The job discovers already-written historical buckets before fetching sources,
writes bounded transactional batches, verifies the complete bucket range, and
rebuilds the provider-free summary read model when it finishes. It can be
rerun safely after an interruption. Historical state reads also retry bounded
transport failures and honor the shared provider-cooldown window in place, so
a dropped THORNode request does not force another block-anchor reconstruction.
If THORNode returns a valid but empty historical oracle list at a height, the
job writes that exact five-minute bucket with a null oracle leg and reports a
source gap; it does not substitute a neighboring price or omit the bucket.

`boonetools-pool-dislocation-repair.timer` provides the live continuity loop.
Every fifteen minutes it scans exact five-minute boundaries across the trailing
seven days and selects both missing buckets and scheduled buckets whose pool
leg came from `thornode-core-snapshot`. Every persisted reference symbol is
checked against the current reviewed asset mapping, and each mapped leg must
contain either a value or explicit unavailable/unaligned provenance. This lets
the repair loop replace a changed mapping such as WBTC's move from `BTCUSDT` to
`WBTCUSDT` without treating unrelated Binance values in the same bucket as
proof that the bucket is complete. It reconstructs at most 24 of the oldest
pending buckets per run using the finalized block and the same provenance rules
as the operator backfill. Historical rows may replace only explicitly degraded
pool legs or mapped reference legs that are null; an ordinary complete
scheduled observation still wins every primary-key conflict. If the exact
historical oracle response or Binance interval genuinely has no value, the null
leg is retained with `thornode-oracle-unavailable` or
`kline-close-unavailable` provenance. That confirmed absence makes later repair
scans idempotent while keeping the chart gap honest. A value that exists but is
more than 30 seconds from the finalized THORChain block is retained as a null
leg with `thornode-oracle-unaligned` or `kline-close-unaligned` provenance; it
is not silently compared across mismatched time boundaries. The repair job
shares the operator backfill advisory lock so the two historical readers cannot
overlap.

## Interface Scope

The mockup establishes these production interactions:

- four top metrics for coverage, largest current gap, seven-day peak, and pool
  count beyond the selected threshold
- one selected-pool chart with trailing 1h, 1d, and 7d controls, horizontal
  highlight-to-zoom with an explicit reset, a zero line, threshold band, and
  independent oracle/Binance series toggles; the taller Y scale derives from
  only the currently visible points and selected references with four-percent
  edge padding, while hover resolves the
  nearest exact five-minute point and shows all three prices plus both signed
  deviations. Independently selectable 1h, 6h, and 1d rolling-average overlays
  use distinct dash patterns and add their signed values plus exact sample
  coverage to the hover tooltip. The legend identifies the 95% minimum.
  All displayed deviations use basis points. Missing reference
  values break the corresponding chart path instead of rendering as zero;
  source controls and legends only expose references mapped for the selected
  pool. Gaps are not interpolated.
- threshold controls at 0.5%, 1%, and 2%
- a default-on `HIDE HALTED` toggle backed by current THORChain inbound-address
  trading flags; enabling it also excludes those pools from leaders, coverage,
  threshold counts, and selected-pool fallback
- all-pool watchlist ranked by current maximum absolute dislocation
- every watchlist column header is sortable in both directions; null source
  values stay at the end of the selected ordering
- current prices, signed source deviations, average/peak absolute deviation,
  trailing 1h/4h/1d/3d/7d absolute averages, time beyond threshold, trend
  sparkline, and state per row
- explicit timestamps, units, formula, sign convention, source freshness, and
  degraded/missing coverage states

## Delivery Slices

1. Frontend information hierarchy and deterministic model tests.
2. Migration, exact asset/reference mapping, five-minute ingestion job, source
   health, retention, and backend tests.
3. Provider-free summary and exact five-minute selected-pool endpoints plus the
   frontend API adapter.
4. Provenance-safe seven-day historical reconstruction, production deploy,
   timer priming, and continuity monitoring.

## Explicitly Out of Scope for V1

- trade execution or arbitrage recommendations
- push/email alerts
- additional CEX/DEX references
- user-defined windows beyond seven days
- inferred mappings based only on ticker text
