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

### Table metric correction — October 29, 2026

The Volume / Depth heading hid a daily normalization: the selected window's
volume was divided by observed days before comparing with current two-sided
depth. The correction uses the entire selected period, consistent with
the adjacent Volume and Fees / Depth columns. The legacy top-level metric
now matches the default 30-day period. All percentage calculations retain
their RUNE basis; historical USD activity totals divided by current USD depth
are a different valuation and need not reproduce those percentages.
Volume / Depth displays a percentage for 24H and a rounded whole-number
multiple for longer windows (for example, 23,851% becomes 239x). Sorting
continues to use the underlying unrounded ratio.

Regression tests also cover observed zero fees/volume (zero rather than
unavailable, while an empty denominator remains unavailable), exact numeric
RUNE balance sorting, and zero expected days for pools first tracked today.
An explicit null `total_depth_usd` now remains a modern two-sided payload;
missing USD pricing must not trigger legacy conversion and halve valid
RUNE-based turnover. Column tooltips identify the RUNE basis and exact bounds.
APR still annualizes over the requested period and requires at least 90%
observed days; this investigation does not change that existing policy.
Deploy the backend before the frontend. The next ordinary Pool Analysis
publication applies the corrected formulas to saved aggregates. These fixes
do not acquire or rewrite history; keep source freshness warnings intact.

At 09:11 UTC, all 44 production sync states reported an unavailable or
unsynchronized Midgard aggregation watermark. This is separate from the
table calculation defects. A read-only audit of the last year's 15,722
nonpartial daily records found no missing USD volumes or positive fees
without a positive RUNE/USD valuation. Local checks: 94 Pool Analysis tests
passed, three optional database tests skipped, and Svelte diagnostics had
zero errors (56 existing warnings).

Migration 059 adds `pool_analysis_depth_daily`; migration 060 adds durable
per-day completion. The fifteen-minute job refreshes today's swap totals and
uses the existing fresh THORNode pool field for today's partial depth. Its
asset price, RUNE balance, and asset balance come from the same pool response;
the observation retains the field's actual timestamp and `thornode-core:pools`
provenance. Stale, future-dated, or prior-UTC-day core observations cannot
populate today's depth.

Swaps and depth have independent `completed_at` markers. A closed day is
sealed only after a healthy Midgard aggregation watermark has passed that
day's UTC boundary, the requested interval and required values are valid, and
the data and marker are saved together. The health check precedes historical
requests, which use the same provider base. Rounded bucket end times alone do
not establish completion.

Normal work requests only missing or incomplete closed days and never crosses
completed days to combine gaps. Newly closed days take priority over a bounded
older backlog. Complete days are skipped across restarts. Legacy rows have no
proven aggregation watermark and receive a bounded one-time validation rather
than being silently certified by their former `partial=false` flag. There is
no recurring 35-day rescan. `pool-analysis-backfill` remains an explicit repair
override for history from 2021-04-01.

Depth acquisition is independent of successful fee writes, with its own
error/stat fields. Public GETs only join stored data and never fetch providers. See
[backend deployment](../docs/boonetools-backend-hetzner.md) for backfill commands.

## Reused snapshot provenance — October 20, 2026

Repeating a refresh in the same quarter-hour previously reconstructed a cached
head without its `source`. The daily upsert explicitly included that missing
field as null, violating the database constraint and marking valid saved rolling
data stale. The synthetic zero-length UTC-midnight head had the same omission.

Both constructors now carry the existing `liquify-midgard-swaps` provenance.
The intraday table is exclusively the swap-prefix ledger; a cache hit retains
that provenance and exact amounts without another swap-history request. A
midnight zero is a derived empty prefix, not evidence that a daily history row
is complete. It stays partial with no completion marker.

No migration, schema relaxation, generic upsert fallback, historical repair,
cache clearing, request-limit change or timer change is needed. Root regression
tests cover cached persistence, midnight persistence and the collector's
same-window error path. The optional PostgreSQL companion uses an isolated
schema and actual migrations to verify reruns, restart reuse, exact integers
and completed-row preservation. All seven targeted regression/PostgreSQL tests
pass without skips against the disposable local database.

After the normal backend release, verify two sequential ordinary refreshes in
the same non-midnight window: the second must reuse saved prefixes, retain their
amounts and provenance, and leave no source-constraint errors or newly stale
pools. Do not run the historical backfill to validate this fix.

## Quarter-hour refresh alignment — October 21, 2026

The activation-relative fifteen-minute timer could drift to `:13/:28/:43/:58`.
A successful `:43` run then published the `:30` source cutoff, which expired
at `:50` under the twenty-minute source-window TTL, eight minutes before the
next scheduled refresh. A fresh read-model publication did not make its older
rolling cutoff fresh; this gap was independent of provider admission limits.

The timer now uses `OnCalendar=*-*-* *:02,17,32,47:00 UTC`, with the existing
30-second accuracy and persistent catch-up, and no relative startup trigger.
It retains four ordinary runs per hour. Regression tests cover arbitrary
activation times and continuity across UTC midnight: with up to 90 seconds of
aggregation lag, 30 seconds of timer slack, and 90 seconds of job runtime, the
previous cutoff is still under twenty minutes old at the next publication.
Those are bounded healthy-runtime assumptions, not an outage guarantee.
Freshness TTLs, provider budgets, collector logic, and saved history are unchanged.

## Short history is not missing history — October 21, 2026

ZEC's recorded history begins October 2, so its October 21 completed-day
fallback contains nineteen days. The former thirty-day coverage check counted
September 21–October 1 as eleven missing observations even though the pool's
tracked history had not begun. Its daily series and recent rolling windows had
no gaps.

The read model now bounds expected completed days by the earliest durable
`pool_analysis_sync_state.first_day` and refresh-state `first_tracked_day`.
The latter prevents failed initial acquisition days from disappearing when the
first successful observation arrives later. This is a tracked-history boundary,
not a newly inferred on-chain creation timestamp. A selected window's first or
last observed row never moves that boundary forward. Invalid/unknown anchors
and contradictory older observations retain conservative full-window coverage.

Coverage exposes `requested_days`, `history_start_day` and `short_history`;
the requested period, source bounds, exact amounts, annualization and rolling
snapshot requirements are unchanged. Genuine missing days after tracking began
still warn, independently of source-staleness and sync-error warnings. No
schema change, provider acquisition, cache clearing or historical rewrite is
needed; the existing UI consumes the corrected missing/incomplete flags.

## Missing rolling boundaries — October 28, 2026

Midgard health failures on October 27–28 left several consecutive quarter-hour
prefixes absent. At October 28 23:45 UTC, ZEC's selected 24H table substituted
October 27's $438.73 in fees although the actual trailing window contained
1,631.52503442 RUNE in fees (about $1,025). Daily history agreed with Midgard;
the discrepancy came from selecting a different window. The former recovery
gate required both adjacent prefixes, so multi-poll outages never qualified.

Recovery now requests only the exact missing 24H starting prefix when a valid,
completed starting day exists. It does not require adjacent polls, interpolate
amounts, rescan completed days, or backfill other periods. The repaired prefix
is persisted and reused across runs. Midnight windows need no prefix request.
Each pool needs at most one extra request in a sweep; existing provider admission,
concurrency and cooldown controls still apply. Failed recovery leaves the
completed-day fallback with its actual bounds; unavailable data stays unavailable.

The table visibly marks fallback rows and explains that their totals cover
completed days rather than the selected trailing window. Hover/detail bounds
use the user's timezone; UTC accounting buckets remain unchanged.

Deploy backend then frontend. No migration, cache reset, historical rewrite or
timer change is needed. Verify an ordinary scheduled publication, exact rolling
24H bounds and saved-boundary reuse. The regression fixture preserves the ZEC
incident's amounts and proves recovery without needing surrounding samples.

## Forward-only daily top swaps — October 29, 2026

Click a daily bar, or choose a local calendar day below the expanded chart, to
open the shared Financials day-detail table for that pool. The chart retains UTC
aggregates; the detail explicitly names the viewer's timezone. Weekly/monthly
buckets retain the date picker without selecting an entire bucket as one day.

`/pool-analysis-swaps?asset=...&day=YYYY-MM-DD&timeZone=...` reads stored facts only.
Migration 077 sets `financials_swap_ledger.pool_started_at`; earlier days return
`before-tracking` without enqueueing work. The launch day discloses partial
coverage and excludes swaps that started before capture. Each subsequent block
records explicit swap-event `pool` and `liquidity_fee_in_rune` in replay-safe
per-block and per-route/pool tables, sharing Financials' atomic block ingestion.
Never divide a route's aggregate fee between its pools. Streams retain their
original local start day and accumulate all executed legs in that pool.

Rank by the selected pool's fees in USD, priced at the saved RUNE price at swap
start. Input value is the whole route's notional; rate is selected-pool fees over
that notional. The existing verifier selects candidates separately for each pool
and exact local window, deduplicates transaction IDs, and retains the same five
requests per 30-second pass. Saved totals and verification survive closed days;
only pending IDs are checked later. No new actions scan, history backfill, or
provider budget is introduced. Independent SIPOL block boundaries expose missing
or unattributed blocks; such rankings remain explicitly incomplete.
