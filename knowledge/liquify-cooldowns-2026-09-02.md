# Liquify cooldown investigation — 2026-09-02

## Production evidence

Read-only inspection of the BooneTools backend at approximately 08:47–09:00
UTC, running release `31e48b4d384d81390939925eaee892c8573004fb`:

- The latest recorded public Liquify HTTP 429 was **August 26, 15:25 UTC**,
  from Midgard `/history/rune`. Its one-hour global breaker expired August 26.
  Earlier journal entries show throttling of historical THOR.RUJI depth and
  RUNE-price requests that afternoon. The breaker row's eight failures are
  cumulative, not eight new incidents today.
- Current failures are predominantly HTTP 500 **“Too many hops”**, unavailable
  historical heights, and timeouts. Examples include historical RPC
  `/block?height=27584790`, collector `/tx_search`, and archive THORNode
  `/thorchain/network?height=20956068` returning a nil-pointer error.
- Seven days of service journals contained **2,130 cooldown messages**,
  including 835 from the chain listener and 274 from Pool Dislocation repair.
  These are downstream skip/error messages, not a count of provider requests
  or independent rate-limit incidents. Matching bare `429` in journals also
  catches process IDs, durations, heights, and payload sizes; those matches
  must not be reported as HTTP rate limits.
- Dedicated RPC and public REST retain separate cooldown namespaces. Current
  REST RPC uses a server-owned authenticated Liquify endpoint; public THORNode,
  Midgard, and WebSocket use gateway routes. The configured THORNode alternate
  is Liquify's archive host, which also has historical failures. No provider
  configuration was changed or alternative endpoint probed in this audit.
- The fee collector head search still queried heights **27,181,679–27,658,737**
  every five minutes. Completed archival searches cover through 27,266,716
  (transactions) and 27,262,738 (blocks). Head `max_height` values are only
  observed matches and cannot prove contiguous coverage.
- POL's ledger was contiguous across 22,131 activation-to-head blocks at the
  snapshot, but service logs contain earlier repair failures. All 13,939
  retained headers in the sampled trailing day had complete POL event fields;
  these include possible RPC enrichment, so this is a reuse opportunity, not
  evidence that 13,939 duplicate RPC requests were made.

No per-endpoint outbound request counters or Portal quota totals were available
in the inspected application telemetry. Request budgets below are derived from
code/timers and current pool counts, not measured billable usage. Provider
responses alone do not prove whether “Too many hops” is caused by our load.

## Corrections

Each bug was reproduced by a failing test before implementation.

- Provider errors containing a height/hash with `429` incorrectly received
  the hour-long rate-limit cooldown. An ordinary HTTP 500 at height 28429400
  reproduced 3,600 seconds instead of 60. Status matching now distinguishes
  HTTP status text from numeric URL content.
- A temporary HTTP 503 with `Retry-After` previously ignored that delay when
  choosing cooldown duration. The header's parsed seconds now provide a
  minimum delay for both ordinary and rate-limit failures.
- POL repair previously discarded all fetched successes when any concurrent
  request failed, and could return while sibling workers kept requesting data.
  Repair now saves bounded chunks, preserves successful work on failure, stops
  scheduling new requests after failure, and drains launched work. Complete
  stored event headers can supply ledger repairs without `/block_results`.
- Wasm collector head discovery uses bounded, resumable search windows with
  explicit contiguous coverage rather than repeatedly searching from
  activation. Existing historical backfill coverage provides a safe initial
  boundary; an observed match alone does not. Search progress and public fee
  completeness remain separate from merely having an empty processing queue.
  Each head query now spans at most 10,000 blocks versus the observed 477,059;
  after catching up, it covers the 1,200-block overlap plus newly arrived blocks.
  This is a reduction in search span, not a measured reduction in billed calls.

These changes reduce unnecessary retries/search work; they do not establish that an
unhealthy upstream historical endpoint has recovered.

## Pool Analysis completion

The subsequent Pool Analysis change keeps the 15-minute live cadence and
adds durable completion per day and per lane. Today needs one swap request per
pool; partial depth comes from the already acquired core pool response. Closed
history is requested only until a healthy provider watermark and validated
interval establish completion. Missing data stays retryable; completed days
are not routinely re-requested. Older existing rows undergo bounded one-time
validation. This replaces the proposed recurring 35-day reconciliation.
Each timer run permits at most 20 historical requests after live work, with
newly closed days prioritized and rotation within both priority groups so
permanent gaps cannot monopolize the allowance. The health watermark is
checked against receipt time, not the earlier job start. Observations replace
all fields together, including null prices, so source values cannot be mixed.

At 43 pools, the steady-state budget is approximately 4,310 requests/day
(4,128 live swaps, 86 daily closure requests, and up to 96 shared health checks),
about 48% below 8,256. Grouping adjacent pending days may reduce closure calls;
initial validation, failures, and provider lag add temporary catch-up work.

## Remaining efficiency opportunities

| Consumer | Nominal requests/day | Opportunity |
| --- | ---: | --- |
| Shared core THORNode | 14,064 | Already staggered by field. `/lastblock` contains L1 heights, so the THORChain head stream alone is not an equivalent replacement. |
| Shared core Midgard | 864 | Already reused across dashboards. |
| Pool Analysis, 43 pools | Previously 8,256; now about 4,310 after validation | Live swaps plus shared core depth; closed days fetched once and durably completed. Initial validation and incomplete days add bounded work. |
| App Layer collector state | 8,160 | Five collectors, live balances/actions every two minutes and config/history every 15 minutes. Consider event invalidation and slower unchanged history/config checks. |
| POL reconciliation, one funded pool | 1,440 plus repair | Feature-specific balance/LP reads already reuse core pools. Reuse complete stored headers before making repair RPC calls. |
| Wasm head-height reads | 864 | Three jobs independently fetch `/lastblock`; reuse a sufficiently fresh durable head with explicit freshness checks. |
| Reserve payment price history | Up to 288 | Existing code re-fetches the entire event date range every five minutes. Reuse completed cached days; fetch missing/open days and periodically reconcile history. |

Other bounded follow-ups:

- Separate ordinary-failure retry bypass from global rate-limit protection.
  Pool Dislocation retries and Node Votes height searches currently have paths
  that disable both with `sharedCooldown:false`.
- Honor HTTP-date `Retry-After` values in the shared HTTP transport; its current
  parser supports numeric seconds only.
- Add redacted request counters by provider/service/job and distinguish
  attempted requests from cooldown skips, cache hits, status, and latency.
  This would support a measured budget and expose synchronized timer bursts.
- Review historical repair lanes independently of current-state acquisition;
  an archive failure can still block ordinary calls sharing its service scope.
- Dune quota failures observed in bond-history logs activate Midgard fallback,
  adding provider pressure beyond nominal timer budgets.

## Validation

`npm run backend:test`: **429 passed, zero failed**. This includes the new
cooldown classification/delay, partial repair/worker drain/header reuse, bounded
collector search/resume, public coverage, and Pool Analysis finality/rotation
regressions. Frontend tests: **280 passed**. `npm run check`, `npm run build`,
and `git diff --check` passed; the Svelte ratchet retained its existing 56 warnings.

An isolated PostgreSQL instance verified migration 060, actual pending-day SQL,
independent lane completion, no history requests on the second refresh,
completed-row protection, explicit repair, retained source timestamps, gaps
surviving outages, and atomic replacement without carrying an old price forward.
The initial production audit was read-only. Deployment follows the normal
exact-commit GitHub `verify` and guarded backend release checks; operational
outcomes are recorded in the shared knowledge log.
