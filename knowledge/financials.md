# Financials dashboard

`/financials` is the protocol-wide volume, income, RUNE price, and bonding APR dashboard.
For local development, start it with:

```sh
npm ci
npm --prefix backend ci
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Development uses `/__financials` in Vite; production uses the shared BooneTools
client and `/functions/v1/financials?range=30d`. Both use the same data model and
collector implementation. Install backend dependencies for either mode.

## Production operation

`boonetools-financials.service` runs an independent collector process. It holds
an advisory lock and keeps independent loops: recent/all-time history refresh
every five minutes, live acquisition every 30 seconds, publication every five
seconds, and bounded reward-event repair and Reserve reconstruction. Slow
archive backfills do not block live publication.
The four allowed range payloads are persisted in existing Postgres
`api_read_models` rows (`financials:30d:v1`, `financials:90d:v1`,
`financials:1y:v1`, `financials:all:v1`). Migration 067 adds the independent
durable `financials_reward_blocks` ledger for exact reward accounting.
Unchanged snapshots are coalesced, with a two-minute publisher TTL. Public GETs
read only these rows, use the shared three-second row cache, and send a bounded
15-second HTTP cache lifetime. Source ages are checked on every GET. Cold data
returns 503/Retry-After; failed acquisition retains last-good values. A stopped
collector cannot promote an old partial day into completed history at midnight.

Completed observations and verified bond totals survive releases in
`/var/lib/boonetools-financials/history-v1.json`, managed by systemd's
`StateDirectory` and written atomically. Include this directory in server data
backups. It is a reconstructible acquisition cache, separate from public read
models and from runtime secrets. A verified development cache may seed a first
installation while the collector is stopped; never overwrite a live cache.
Partial-day data is not written into this completed-history file.

Production calls use the shared provider transport/metrics/circuit breakers,
with separate Financials live/history/archive ordinary-failure scopes and
gateway-wide 429 cooldowns. Sources remain the verified public Liquify paths.
The guarded backend deploy starts the collector, installs its backend-only
protobuf dependency, and includes the default Financials route in its latency,
payload, compression, and freshness gate. Deploy backend before frontend.
Collector startup is conditional on its unit existing so rollback to older
releases remains supported; rollback does not delete retained Financials data.

## Accounting

- The amber line defaults to closing RUNE/USD price. The sliding control switches
  it to bonding APR without resetting zoom; price stays USD even when volume and
  income are denominated in RUNE. Weekly/monthly prices use the closing observation,
  APR uses the mean daily rate, and missing prices remain gaps.

- Default: 30 UTC calendar days including today. Additional ranges: 90D, 1Y,
  and all time from the multi-chain mainnet/Chaosnet launch on 2021-04-13.
  Today's partial bucket is explicitly marked; unindexed intervals stay unavailable.
- Volume: protocol-wide Midgard `/history/swaps`, with no pool filter. Uses
  executed pool legs, including both legs of cross-asset swaps. `totalVolume`
  is RUNE e8; `totalVolumeUSD` is USD cents at swap-time prices.
- System income: Midgard `/history/earnings.earnings`, retained reported income.
  The separate breakdown is gross liquidity fees + independently verified
  Reserve emissions − finalized REVSHARE payouts + a disclosed reconciliation
  adjustment to Midgard's reported total. Midgard `blockRewards` is a signed
  earnings-minus-fees residual, **not** actual Reserve emissions; adding
  REVSHARE back to it is also insufficient. USD income multiplies RUNE
  income by that same bucket's closing `runePriceUSD`. Today's provisional USD
  income uses its latest covered five-minute closing price.
- Daily bonding APR: `bondingEarnings / activeBond * 365 * 100`. It is a simple
  gross annualized protocol rate, not compounded APY or an individual provider's
  return after operator fees, bond caps, or performance adjustments.
- The active-bond snapshot is queried at the latest indexed action block before
  each UTC midnight. If that action is from an earlier day, a bounded block-time
  search proves the closing height with adjacent headers on either side of
  midnight. This also handles days without indexed actions. This is a closing
  balance approximation, not a balance weighted by time throughout the day.
  Bonds, unbonds, and nodes entering/leaving the active set affect the denominator;
  bond withdrawals do not become negative earnings.
- Missing source data remains `null`; lines have gaps. Observed zero days remain
  zero. Cards report observation counts; totals include today while daily income
  and APR averages use only observed completed days.
  Zooming changes card totals to the selected chart window.

## Live updates

The visible dashboard checks for fresh data every 30 seconds (every 5 seconds
while bond snapshots are pending). Background tabs pause polling and refresh
when visible again. Same-day refreshes preserve chart zoom, selected currency,
and hidden series. At UTC midnight the rolling window advances and resets zoom.

Midgard's unfinished daily and hourly intervals were observed returning zero
placeholders even while five-minute intervals showed real activity. Today is
therefore assembled from **completed five-minute intervals**, summed exactly in
base units. The cutoff is the last five-minute boundary behind both the source
watermark and local clock. Intervals must form complete contiguous coverage;
an incomplete response retains the previous snapshot with a delayed status.
This is near-live, five-minute-step data, not a per-block event stream.

Today's APR is `node rewards / active bond * 86400 / covered seconds * 365 * 100`.
Its bond snapshot uses the latest indexed action before the same cutoff, with
the existing block-time fallback for no-action days. The estimate is marked in
the chart and table, and can be volatile early in the day. Bond retrieval runs
in the background; no previous day's balance is substituted for a missing one.

The dev service coalesces refreshes across tabs/ranges; the production collector
acquires independently of visitor traffic. Both reuse totals until the
five-minute cutoff changes. Partial-day totals and bonds stay in memory only,
never in the completed-day disk cache. A new UTC day clears the old partial
snapshot even during an outage. Completed daily history replaces yesterday's
intraday data rather than carrying a partial total forward.

## Day drill-down

Click a daily chart bucket or use the UTC date picker to expand two tables below
the plot: the ten largest successful swaps by input USD value (once per route),
and ten pools by executed USD volume. Weekly/monthly views retain the date picker
rather than treating an aggregated bucket as one day. Transaction links open the
explorer; the tables always identify their USD ranking basis, independently of
the chart's denomination. Dragging to zoom must not select a day.

`/financials?day=YYYY-MM-DD` validates the mainnet date range and enqueues/reads
`financials_day_details` (migration 068), without upstream calls in the public
handler. The existing independent Financials collector advances up to ten requests
per pass on a separate five-second loop. Each request checkpoints the opaque
Midgard cursor and compact top-ten candidates; errors retain the last checkpoint
and last-good payload. Full-day acquisition can take several minutes on busy days.
Repeated visitors share the same scan and result. No extra service/timer is needed.

The source horizon is pinned to a completed five-minute boundary behind Midgard's
watermark and the clock. Descending action pagination continues past UTC midnight;
only successful, priced actions inside `[day start, cutoff)` are ranked. Missing
prices and pending swaps are disclosed, not converted to zeros. Streaming swaps
use their Midgard action date, not a claim that every sub-swap executed that day.
Pool discovery combines the matching earnings intervals and encountered action
pools. Each pool's volume uses `/history/swaps`, with exact contiguous coverage
and base-unit validation, rather than attributing input value to every pool.
Completed pool days first reuse `pool_analysis_daily` only when the asset, UTC
interval, source, raw units, non-partial status and completion watermark all match.
Missing pools still use the budgeted source; the tracked-pool subset never replaces
discovery of the full day's pool universe. No ranking is published until both
complete scans finish.

### Request efficiency and bounded acquisition (October 18, 2026)

A completed UTC-day snapshot is retained without automatic rescanning, even when
pending or unpriced actions remain. Acquisition completion is not financial
finality: the UI identifies exclusions and late settlements can change the true
ranking. The October 24 targeted settlement pass below supersedes the original
freeze of pending IDs, without restoring the old fifteen-minute full-day repeat
triggered by a single unresolved action.

Before the October 22 background-roster update, today's completed prefix
refreshed at most every fifteen minutes while viewed.
It scans only the new action interval and merges the prior and new top tens;
pool totals refresh for all discovered pools. Up to 512 unresolved transaction
identities are retained to reconcile reappearing actions. Legacy count-only
exclusions and overflow stay explicitly provisional; rare stale duplicates outside
retained identities can conservatively overcount exclusions. Legacy in-progress cursors
resume in place; subsequent completed prefixes use delta acquisition.

For untracked historical dates, public reads renew a two-minute visitor lease; the worker checks that lease before
each source step. Leaving/closing the panel or hiding the tab pauses unfinished
work after the lease expires, preserving its checkpoint. Reopening resumes it.
Provider and request-budget deferrals preserve state and honor the advertised
retry time. Completed-day reads cost zero upstream calls.

Migration 069 adds an atomic Postgres request budget shared by backend processes
for each Midgard provider. All `/actions` and Financials day acquisition requests
consume a bulk subset of the total budget. Defaults are 60/minute, 2,000/hour and
20,000/UTC day total, with bulk capped at 30/minute, 1,000/hour and 5,000/UTC day.
These are application safety limits, **not published Liquify public-gateway quotas**.
Bulk therefore cannot consume the whole allowance for normal reads. Admission is
checked before HTTP, after circuit-breaker checks; deferral does not record a 429
or poison provider health. Storage failure defers safely. Existing provider-wide
429 cooldowns remain in force. Counters survive processes and deploys; no reset or
historical request accounting is implied by first installation. The collector
logs acquisition/cache metrics every minute.

The remaining first-visit cost is substantial: Midgard `/actions` returns at most
50 entries and offers no amount ordering/filter, so an exact ranking for 37,500
actions requires roughly 750 action pages, plus source metadata and uncached pool
days. The bulk cap deliberately spreads that across tens of minutes and can defer
it longer when other consumers use the allowance. Existing Rapid Swaps/affiliate
datasets cover subsets, not all routes, and cannot replace this scan honestly.
A canonical local all-swap ledger would be a separate ingestion project.

The local Vite route uses the same acquisition/normalization and a process-local
budget with these limits and one-second Midgard start spacing. Its day cache and
counters do not survive Vite restart or share the production database. Production
cursor/results and request counters survive service restarts and immutable releases
in Postgres. No historical cache reset or provider warmup is needed.

### Proactive daily rosters (October 22, 2026)

Migration 072 separates collector-owned rosters from visitor-owned historical
work. The collector creates today's UTC roster automatically, adopts an existing
unfinished yesterday row, and retains background ownership after rollover until
coverage is complete. It does not create an unbounded historical queue. Fair,
bounded batches share the existing global bulk admission limits and preserve
cooldown deadlines. Every successful step checkpoints state before continuing.

A completed prefix keeps its compact top ten and scans only new action time.
Background horizons use quarter-hour boundaries with three minutes of settling
time; source lag cannot advance or regress a published watermark dishonestly.
Pool ranking requests can now reuse `pool_analysis_intraday_snapshots` when
asset, exact end time, observation time, and integer amounts match. These rows
are midnight-to-cutoff prefixes, not interchangeable five-minute buckets.
Missing/mismatched snapshots fall back through normal provider admission; a
database failure does not cause an upstream request storm. Completed days still
use the separately verified `pool_analysis_daily` cache.

The final interval is acquired after midnight and source coverage, rather than
freezing an incomplete roster at the wall-clock boundary. Once the day is fully
acquired, future reads are cache-only. Pending/unpriced exclusions and their
provisional warning remain; saved pending IDs are now handled by the targeted
settlement pass below.
This moves first-view latency into bounded background work and removes repeated
pool history fetches, not the unavoidable one-time scan of every action page.
An initial bootstrap or an old uncached date can still be slow or quota-deferred.
The Vite adapter mirrors scheduling but remains process-local, not durable.

### Targeted pending settlement (October 24, 2026)

A full-day acquisition horizon no longer freezes the status of saved pending
swaps. The existing bounded queue checks only retained pending transaction IDs
with Midgard `/actions?txid=...`. It does not repeat health, earnings, action-page
or pool-history acquisition for a closed day. Each successful lookup checkpoints
its cursor and updated top ten together; the saved pool totals and day horizon
stay intact. Exact input-transaction identity and Midgard's action-date bounds
still govern inclusion. A successful refund without a competing unresolved swap
resolves an exclusion without becoming a ranked swap; ambiguous mixed responses
stay provisional. Missing prices remain unpriced, never zero.

Existing closed snapshots with retained IDs are eligible without an open viewer.
The same request cap, provider admission, cooldowns and fair queue scheduling
apply. Unresolved passes back off for one hour, then six hours, then at most one
pass per day. A provider error preserves the current ID for retry; a valid but
still-pending or absent action advances to the next saved ID. No cold historical
dates are created for reconciliation. Legacy count-only exclusions and IDs lost
to the 512-ID cap remain explicitly provisional rather than causing a rescan.

The additive `settlement` metadata distinguishes pending checks, complete checks,
and unavailable reconciliation, with the last completed pass and next scheduled
pass. Exclusion counts describe saved source observations, not a live on-chain
in-flight count. While checks are pending, an open panel polls only the cached
backend result; source requests belong to the background queue. Fully resolved
closed days cost no further provider requests. Unpriced-only exclusions are not
automatically retried by this pending-ID repair.

## Historical state and acquisition

### Reserve emissions and REVSHARE (October 13, 2026)

The consolidated chain listener reuses finalized NewBlock events with no extra
polling. Each durable observation retains the exact `rev_share.payout` sum and
compact Reserve bank deltas from both transaction results and finalized events.
Finalized failed-transaction events still include committed ante fees: reviewed
Cosmos SDK v0.53.0 discards failed message events, not the successful ante-stage
transfer. Block 28232330's 2,000,000 e8 ante receipt reconciles its full bank
delta exactly against historical Reserve balances on both sides of the block.
The first positive indexed payout is block 28146078 at
2026-10-07T20:29:31.355014883Z; earlier windows have known-zero REVSHARE, but
that does not establish their emissions. The separate repair loop reuses SIPOL
block timestamps and requests block results in batches of 10, capped at 2,000
blocks / 20 seconds per pass, with five seconds between passes.

Actual emissions use `historical-reserve-formula-v1`, pinned to reviewed
THORNode v3.20.3 (`b08d81f79275093b0fcb753e0d68ff1c16c51cb8`). Height-verified
historical bank balance, version, and Mimir queries anchor contiguous backward
replay of compact bank movements. The Reserve balance immediately before the
reward calculation (after REVSHARE) feeds the protocol formula, including its
cap override and sequential Cosmos 18-decimal half-even rounding. Reward event
amounts must reconcile with real outgoing bank transfers. Unsupported versions,
configuration boundaries, missing transactions/events, or height gaps fail
closed. No current balance is substituted for historical state. Reconstruction
is bounded to 5,000 observations per pass and stores its evidence in the ledger.

Verified block 28204118 emitted 4,822 e8 RUNE (0.00004822 RUNE); backward
reconstruction also matched independently queried state at block 28204117.
As of rollout, Liquify block results were only retained from height 28124001
(October 6). Initial repair therefore starts at October 7 UTC. Older income and
APR remain available from existing sources, but their unverified emission
breakdowns remain null. Do not synthesize historical emissions from Midgard.

Daily and live accounting require all heights plus adjacent UTC/cutoff boundary
proof from the durable SIPOL ledger. A single missing block keeps that interval
unavailable. Comparison methodology v4 reads the same ledger: retained fees are
gross fees minus REVSHARE; net is retained fees minus actual Reserve emissions.
Missing THORChain coverage does not hide NEAR or Chainflip. A monthly THORChain
net total requires every constituent day and therefore remains unavailable for
October until earlier evidence can be sourced. Preserve both raw acquisition
caches; this migration never resets them. Local Vite has no production ledger
by default and likewise leaves the new breakdown unavailable.

Use Liquify Midgard and RPC. On 2026-09-10, the REST `/thorchain/nodes?height=…`
endpoint returned current validator state even with the Cosmos height header;
node `status_since` exceeded the requested height. It must not supply the
historical denominator. RPC `abci_query` with `/types.Query/Nodes`, empty data,
and explicit height returned the corresponding historical balances.

The narrow protobuf decoder reads status (field 2), status height (field 7),
and bond (field 9, formerly `bond`, now `total_bond`), ignoring unrelated fields.
Both the ABCI response height and node status heights are validated before use.
Standby/disabled balances are excluded. The schema lives in ThorNode's
`proto/thorchain/v1/types/query_node.proto`.

Local Vite caches completed history and verified bond totals under
`node_modules/.cache/financials/history-v1.json` (ignored, disposable). The
browser receives compact daily values, never the large validator responses.
History pagination respects Midgard's 400-interval cap and uses only `from`
and `count`. Earnings use 60-day pages because the upstream includes every
pool. Each successful page is saved before acquiring the next one.

APR backfills newest-first with three archive requests in flight, paced with
the other provider calls to at least 650 ms between starts. Large historical
node responses can take tens of seconds. A 60-second per-request deadline,
retry delay, and an hour cooldown on 429 bound recovery. The chart updates as
historical bonds arrive. Repeated explicit archive-unavailable responses stop
older requests for that server session; missing older APR remains a visible gap.
An unavailable archive day is never filled with the current bond balance.

## Verification

```sh
node --test backend/tests/financials.test.js backend/tests/financials-production.test.js
npm run check
npm run build
```

Tests cover UTC boundaries, USD/RUNE units, emissions in system income,
historical daily price alignment, missing versus zero values, unbonding,
pagination, RPC height checks, protobuf precision, active-node filtering, and
cache reuse with stale-data fallback, partial APR scaling, five-minute source
coverage, refresh coalescing, midnight rollover/recovery, provider-free public
reads, independent publication during slow backfills, graceful collector
shutdown, and rollback-compatible unit startup.
