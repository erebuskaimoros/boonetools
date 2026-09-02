# Sitewide acquisition redundancy — 2026-09-02

Audit of production release `8c0556d027d304d5ddff993cda3b2f536fbadd76`
after the Pool Analysis completion change. The findings below describe that
baseline; the subsequent authorized patch is recorded in the implementation
section. Existing unrelated working-tree changes are excluded.

## Evidence and limits

- Traced scheduled jobs, provider helpers, storage/cache ownership, and
  frontend components reachable from `src/App.svelte`.
- Checked production timer settings: core 15 seconds, App Layer and System
  Income POL two minutes, Reserve five minutes, Treasury five minutes.
  `APP_LAYER_LIVE_STATE_TTL_SECONDS=120`; static state uses the 900-second default.
- Production retains 126 Reserve daily RUNE-price rows from April 30 through
  September 2. Their latest `updated_at` was 07:50 UTC, but the previous upsert
  did not update that column. This timestamp does not establish the latest
  price refresh or request rate; code-derived costs are not measured traffic.
- There are no comprehensive outbound endpoint counters. Counts below assume
  normal configured cadence and relevant paths executing; timer coalescing,
  errors, fallback selection, cache hits, and retries change actual traffic.
- Browser calls to providers are separate from server cooldown bookkeeping.
  A browser request count does not prove consumption of the server's dedicated
  Liquify quota.

## Highest-value provider opportunities

### 1. Reuse the durable chain head and exact block timestamps

Three Wasm jobs independently ask `/thorchain/lastblock` solely for the current
THORChain height (`backend/src/shared/wasm-arb-economics-ingestion.js:1749`).
System Income POL repair asks RPC `/status` on each repair batch
(`system-income-pol-repair.js:128`; normal scheduler every two minutes).
Reserve scheduled discovery also asks `/status` for height
(`rujira-reserve-payments.js:972`).

Nominal head reads are **864/day for Wasm, 720/day for POL's usual single
batch, and up to 288/day for Reserve's scheduled-candidate path**. The listener
already writes `chain_block_headers`, and core provides recent lastblock data.
Use the fresh durable head first, retaining provider fallback for stale or
missing coverage. Pass the resolved head through repeated POL repair batches.

Reserve candidate enrichment (`rujira-reserve-payments.js:1200`) and market
snapshot acquisition (`thorchain-market-snapshots.js:112`) also fetch blocks
solely for timestamps. Exact-height stored headers can answer those lookups.
Headers retain 48 hours, so archive fallback remains necessary. They do not
contain every raw transaction/finalize event and cannot replace arbitrary
`/block_results` requests.

Keep core's own `/lastblock` acquisition: it contains external-chain heights,
which a THORChain-only head stream cannot supply.

### 2. Cache App Layer action definitions as configuration

`app-layer-live-state.js:102` treats only config and migration history as
cacheable. Five balance queries and five action-definition queries execute
every two minutes. A provider-free 24-hour simulation of the current code at
exact two-minute intervals produced **8,100 calls**: 3,600 balances, 3,600
actions, 450 config, 450 history. The 15-minute static TTL becomes 16 minutes
when tested only every two minutes.

The local Rujira revenue contract returns stored action definitions for
`QueryMsg::Actions`; execution advances a separate cursor. Moving definitions
to the current static cadence would reduce **3,600 to 450/day**, saving about
**3,150 calls/day**. Migration history could also be cached much longer.

This is not automatically a free freshness change. To preserve current
mutation detection, invalidate definitions on relevant Sudo/migration events
and recover invalidations after listener gaps, with a safety TTL. Verify the
deployed contract versions against the local mutation contract before relying
on it. Do not freeze the whole config response: it includes `last_executed`.

Sources: `backend/src/shared/app-layer-live-state.js:55,68,102`;
`../../Rujira/contracts/rujira-revenue/src/contract.rs:195`.

### 3. Extend closed-bucket completion to Burn and historical prices

Burn's five-minute job asks for seven daily earnings buckets, exact current-day
earnings, and all-time earnings (`burn-tracker-ingestion.js:129`). That is
**864 calls/day nominal**. Completed daily storage plus a complete historical
baseline can remove most of the **576 repeated history/all-time calls/day**,
while retaining the live request and a separate independent reconciliation.
Require contiguous coverage and source aggregation evidence before treating
the locally summed total as authoritative.

Reserve pricing fetches the entire event-date range before consulting its
daily-price table and rewrites all non-Dune event prices
(`rujira-reserve-payments.js:1249`). Apply cached completed days first; fetch
missing/open days only. This cuts repeated payload and writes. It does **not**
save 288 calls/day if the open day still requires one five-minute request.
Base Fees similarly fetches weekly prices before trying its stored weekly
cache when unpriced events arrive (`rujira-base-fees.js:1922`).

Wasm pricing takes the oldest 5,000 unpriced fees, then fetches the global
earliest-to-latest five-minute depth range for every denom, keeping successful
pages only in a temporary map (`wasm-arb-economics-ingestion.js:1416,1500,1535`).
Persist completed `(asset, interval, source)` buckets and request each denom's
own missing intervals. Otherwise unresolved rows can cause repeated historical
pages every five minutes. Daily/weekly averages, depth-bucket prices, exact
height prices, and current Oracle prices are different inputs; share matching
raw observations rather than substituting different valuation conventions.

### 4. Stop request-driven rescans in Dynamic Fees

The active ADR26 dashboard requests 400 days of affiliate volume. After a
15-minute response-cache expiry, the handler walks up to **500 Midgard pages
of 50 actions**. Summary and transaction drilldown have separate response
keys, and a failed multi-page scan preserves no progress.

Persist canonical affiliate actions and completed daily aggregates, then
refresh a bounded recent tail. Retain source-independent identities,
executed-leg volume accounting, and bounded lazy transaction detail. The
500-page figure is a maximum per cache miss, not a typical page count.

Sources: `src/lib/DynamicFeeDashboard.svelte:312`,
`backend/src/handlers/dynamic-fee-affiliate-volume.js:53`,
`backend/src/shared/dynamic-fee-affiliate-volume.js:24`.

### 5. Persist discovery coverage and reuse immutable archive inputs

- **Node Votes:** rolling scans use the latest matching event rather than a
  completed scan boundary. Time-to-height bisections and matched-block time
  lookups repeat (`node-votes.js:473,709,784,998`). Two full-height bisections
  can mean roughly 50 block requests per hourly run, before event lookups.
  Persist verified scan ranges per source/event lane and cache exact block
  times. Existing min/max matched-event heights cannot serve as completeness
  cursors unchanged.
- **Bond History:** address-specific churn calculations re-fetch the same
  network-at-height and node-at-height inputs (`handlers/bond-history.js:483`).
  Share those immutable raw inputs across addresses while keeping calculations
  separate. Save proven empty periods explicitly. Action discovery also
  restarts from the historical beginning after its six-hour cache expires;
  use a durable cursor and bounded late-indexing overlap. Midgard fallback can
  cost up to 20 pages per refresh per address.
- **Reserve Dune:** the five-minute path executes from the fixed April 30
  start through a moving end (`rujira-reserve-payments.js:1806`). A durable
  covered-through cursor shrinks query work and downloaded rows without
  changing execution frequency. Less frequent Dune execution would be a
  separate canonical-freshness decision.
- **TC Fee fallback:** an incomplete Dune result re-fetches Midgard swap volume
  and CMC data already fetched for the same batch
  (`tc-fee-dash-ingestion.js:435,460`). Pass successful acquisition results into
  fallback; no cadence change is needed.

## Shared reads still duplicated across visitors

| Surface | Remaining repeated acquisition | Opportunity |
| --- | --- | --- |
| Dynamic Fees | `2 + T` direct THORNode requests per mount for global epoch data plus T thornames; component-local Midgard earnings/RUNE history | Shared backend epoch/thorname snapshots and completed history. Keep sealed/live epoch semantics. |
| Vault Explorer | Three direct Liquify calls per mount/manual refresh: vaults, trade units, secured assets | Share current snapshots across visitors, retaining observation age and vault-versus-pool accounting. |
| Bond Tracker | Loads core nodes, then N direct `/node/{address}` requests for N bonded nodes | Reuse loaded node objects when their age meets the feature's freshness policy. |
| Stock comparisons | Backend Yahoo proxy fetches once per symbol on every origin request; only sends browser Cache-Control | Add server single-flight and persistent historical price caching; preserve quote freshness and market corrections. |

Relevant sources: `DynamicFeeDashboard.svelte:209,269,311`,
`src/lib/vault-explorer/data.js:27`, `BondTrackerV2.svelte:225,287,363`,
`backend/src/handlers/stock-prices.js:17`.

## Smaller deterministic duplication

Treasury first fetches `/thorchain/balance/module/treasury`, which already
contains the module address and balances, then fetches bank balances for that
same address (`treasury/providers.js:117`; `treasury/builder.js:359`). The local
authoritative THORNode query reads the module account's balances directly
(`../../ThorNode/x/thorchain/querier.go:89`). Reuse a fresh successful module
response; retain bank fallback when needed. This avoids about **288 Liquify
requests/day** at the five-minute schedule.

Treasury EVM batches also repeat token `decimals()` on every refresh
(`treasury/providers.js:249`). Production currently tracks nine BSC/AVAX/Base
tokens: cacheable metadata represents about **2,592 RPC operations/day**.
These are operations inside existing batch HTTP requests, not 2,592 removable
HTTP requests, and are not Liquify calls. Revalidate on upgrades or an explicit
metadata policy.

## Browser/database work, not Liquify usage

- **Status:** about 540 internal GETs/hour per continuously open view,
  including 240 uncached block-history reconciliations despite healthy SSE.
  Reconcile on reconnect/gaps, keep a slower history-repair safety check, and
  pause hidden views (`src/lib/status/BlockProductionChart.svelte:131`).
- **Rapid Swaps:** 30 market-history GETs/hour against a 30-minute publisher,
  plus 30 summary GETs/hour. Give history a separate cadence or reuse its
  version; pause hidden polling (`src/lib/RapidSwaps.svelte:421,441`).
- App Layer, Node Votes, and Burn also continue routine HTTP polling while
  hidden. These handlers read stored models, so reducing their requests saves
  browser/server/database work without reducing provider acquisition.

## Already shared or intentionally distinct

Core node/pool/network/Mimir fields, backend block streaming, Pool Analysis
completion, Treasury LP discovery, stuck-transaction fingerprint caches, and
currency-rate single-flight caching already remove substantial duplication.
Earnings midnight balance baselines are already durable by day; closed-day
settlement reconciliation there is database work, not Liquify acquisition.

`NodeOperator.svelte` and the six-second RUNE-price subscriber are unreachable
from current production routes. The legacy nodeop leaderboard handler still
fetches nodes, but its component cadence must not be counted as active site
traffic. Existing explicit historical repair paths and independent canonical
reconciliation must retain their correctness purpose.

## Suggested sequence

1. Reuse fresh durable heads/timestamps and Treasury module balances; pass
   successful TC Fee inputs through fallback. These preserve normal cadence.
2. Add durable completion for Burn and matching historical price buckets, and
   make Dynamic Fees affiliate acquisition incremental and resumable.
3. Share remaining global browser inputs; cache collector definitions with
   reliable mutation invalidation rather than silently weakening freshness.
4. Reduce hidden/redundant internal polling. Add per-provider/endpoint outbound
   and cache-hit counters to measure savings separately from cooldown skips.

## Implementation

The follow-up patch covers all identified acquisition and polling areas:

- Migration 061 separates durable raw observations from expiring response
  caches. Completed observations require validated complete replacements;
  TTL expiry alone never establishes completion. Shared acquisition uses
  per-key single-flight plus PostgreSQL locks, with lock-bearing work
  serialized on each SQL session to avoid cross-key deadlocks.
- Wasm, Reserve and POL repair reuse fresh stored/core heads. Exact block
  timestamps remain reusable after the 48-hour header retention window.
- Treasury reuses fresh module balances and revalidates EVM decimals daily;
  its balances continue to refresh every run. Yahoo history uses a one-hour
  server cache and quotes five minutes, preserving market corrections.
- App Layer action definitions use the static cadence and migration history
  a 24-hour cache only while independent event coverage is healthy. Mutations
  invalidate them; listener gaps fall back to the original polling cadence.
- Burn completes verified closed days and independently audits a complete
  baseline daily. Live current-day acquisition continues every five minutes.
- Reserve/Base Fees share matching daily/weekly RUNE observations, and Wasm
  persists source-specific five-minute prices with per-denom missing ranges.
  TC Fee fallback receives successful inputs from the same attempt.
- Bond shares immutable node/network snapshots and proven empty churn
  calculations. Its Midgard discovery persists source-bound fixed windows
  and page progress; Dune seeds once, with canonical events retained.
- Dynamic Fees persists canonical actions, daily aggregates, and resumable
  page state. Its dashboard GETs and Vault Explorer read shared backend
  observations; a minute worker performs queued provider work.
- Node Votes uses independent verified scan state rather than the last
  matched event, and reuses exact timestamps. Failed/truncated work does not
  advance scan coverage or turn missing history into a complete empty range.
  Dune stays the normal Mimir delivery source with a separate query-progress
  record and late-index overlap, avoiding an additional duplicate RPC scan.
  Upgrade/protocol RPC coverage preserves older retention gaps explicitly.
  At verification, both configured production RPC providers advertised
  retained blocks beginning August 26; that cannot certify six-month history.
- Bond Tracker reuses fresh core nodes. App Layer, Burn, Node Votes and Rapid
  Swaps pause hidden polling; Rapid market history has a separate cadence.
  Status block history reconciles on gaps/reconnects with a slower safety
  poll while SSE is healthy.
- Bounded job/API log counters distinguish outbound attempts, cooldown
  skips, cache hits, and coalesced work without logging credentials or
  request identities. These measure the common backend transport; they are
  not a count of unrelated external/browser traffic.

Validation includes failing-before/fixed-after acquisition regressions and a
provider-free PostgreSQL script covering eleven groups: immutable completion,
cross-session coalescing and opposite lock ordering, collector gaps/mutations,
Burn baseline integrity, price reuse, Dune cursor validation, atomic affiliate
page persistence/rollback, bounded details, idle visitor work, UTC days across
DST, and outer cache expiry bounded by underlying source expiry. All new
migrations through 064 applied to a fresh disposable database.
The final working-tree suites passed 510 backend tests and 288 frontend tests;
the production build and architecture/surface checks passed. Svelte reported
zero errors and 56 existing warnings. The workspace ownership audit reported
zero errors and warnings. Deployment uses the normal clean-commit CI gate.

### Deployment verification follow-up

The first rollout exposed two issues before the frontend was switched. The
normal mandatory warmup gate restored the previous verified backend release.

- Base Fees avoided unchanged writes but still scanned its approximately
  7.8 GB event heap to reconsider historical valuations. Pricing now returns
  immediately without unpriced included events, preserves assigned values,
  and updates only pending rows in the required UTC weeks. Migration 065 adds
  a partial index for finding those rows without reading completed history.
  Three PostgreSQL regressions cover idle history, late events, existing
  weekly observations, UTC boundaries, and preservation of prior valuations.
- Visitor snapshots require fresh core data. With timers stopped, earlier
  deployment primes could outlast the core TTL. Each mandatory visitor prime
  now refreshes core immediately before use and allows the queue's one-minute
  retry delay to elapse before retrying. Five executable deployment tests
  cover slow primes, deferred work, repeated recoverable failures, and bounded
  failure without weakening freshness or deployment gates.

The revised backend suite passed all 518 tests with the three pricing checks
enabled against PostgreSQL. All eleven integration groups also passed after
migration 065. Read-only production EXPLAIN confirmed the bounded pricing
update uses a time index; the new partial index supports the empty-work check.
