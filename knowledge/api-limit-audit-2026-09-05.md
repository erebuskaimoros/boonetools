# API limit audit — September 5, 2026

Read-only production inspection around 08:21–08:26 UTC. Production release:
`64e3c3a1fc12828bf00cd0145c7e27275949daba`. No runtime configuration or code changed.

## Confirmed limits

- Vanaheimex Bifrost scanner `/api/nodesInfo` returned HTTP 429 at
  **September 5 07:44:40 UTC**: “Too many requests from this IP, please try
  again later”. Its persisted global cooldown expires at 08:44:40 UTC.
- The core snapshot is the scanner's observed caller. Successful requests
  immediately before the failure were approximately five minutes apart,
  consistent with its 300-second configured cadence. Counters show one failed
  attempt at 07:44:40, followed by cooldown suppression. This does not establish
  the provider's threshold or whether other applications share this IP's budget.
- The Vanaheimex breaker has 19 cumulative failures; that is not 19 new incidents
  today. Seven scanner HTTP failures appear in available post-deploy counters;
  those counters omit status codes, so only the latest retained error is
  independently confirmed as 429 here.
- Liquify's persisted global 429 remains **August 26 15:25 UTC**, on Midgard
  `/history/rune`, with cooldown expiry August 26 16:25 UTC. Recent service
  breakers instead show HTTP 500 and transport failures. Current journals
  contain “Too many hops” errors. No new explicit Liquify 429 was found in
  September 2–5 service journals; handled failures need not print their body.

## Measured background load

Summed completion/API acquisition counters, UTC days:

| Metric | September 3 | September 4 |
| --- | ---: | ---: |
| All common-transport outbound attempts | 80,473 | 75,037 |
| Liquify outbound attempts | 75,967 | 70,715 |
| Liquify failed attempts, all causes | 418 | 982 |
| Liquify cooldown skips, **not outbound requests** | 17,163 | 14,718 |
| Pool Dislocation repair attempts, all providers | 26,214 | 19,542 |
| Core snapshot attempts, all providers | 12,589 | 13,018 |
| Treasury snapshot attempts, all providers | 6,964 | 7,365 |
| Status dashboard attempts, all providers | 5,934 | 5,619 |
| Wasm fee ingestion attempts, all providers | 5,071 | 3,424 |

Counters cover instrumented backend transport, not provider billing, other
applications, direct browser traffic, or every possible transport. September 2
is partial because these counters arrived with the evening deployment.

Pool Dislocation repair is the largest observed source. It runs every fifteen
minutes and resolves historical block anchors for up to 24 incomplete buckets
from a seven-day window. September 3 counters include 18,330 authenticated
Liquify `/block` attempts and 6,608 public RPC `/block` attempts across jobs.
This is substantial historical acquisition pressure, but does not prove that
it caused the August 26 limit or current upstream HTTP 500 errors.

## Interpretation

The current confirmed throttle is the scanner provider's IP limiter. Its
observed cadence does not show a runaway polling loop; provider-side limits and
host-wide consumers remain necessary to explain why that cadence was rejected.
Liquify traffic is predominantly scheduled acquisition, with historical repair
the largest measured contributor. Prior repeated-history inefficiencies and
cooldown-classification fixes are documented in `liquify-cooldowns-2026-09-02.md`
and were already included in the inspected production release.

Next investigation should establish Vanaheimex's allowed cadence/IP accounting
and inspect Pool Dislocation repair's repeated block-anchor work. Provider
Portal usage is needed to attribute billed quota exhaustion conclusively.

## Pool Dislocation follow-up — implemented locally, not deployed

Tracing the repair path exposed three independent inefficiencies, each reproduced
before its fix:

1. The planner requires a height and stored market snapshot, but the upsert
   rejected historical replacements of scheduled rows whose prices were already
   populated. Production rows at August 29 08:35 onward have populated reference
   prices but null heights. Repair could never complete those rows. Logs include
   16 zero-write 24-bucket runs on September 4; their overlapping windows advanced
   by only fifteen minutes as old buckets aged out of the seven-day window.
   The SQL regression reproduced `rowCount=0`; a validated historical replacement
   now writes the complete row and removes that bucket from the next repair plan.
   Healthy scheduled observations remain protected.
2. Timestamp-to-height search cached only within one invocation. A second run of
   the same two buckets repeated all five status/block requests. Complete adjacent
   bracket proofs now persist in the existing shared observation store, and search
   candidates reuse shared exact timestamps/headers. Repeating those buckets now
   adds zero RPC requests, even after provider removal or failure. Partial successes
   remain available when a later bucket fails. No schema migration is required.
3. Interpolation can degenerate into near-sequential probing around uneven block
   intervals. A monotonic synthetic timeline with a long late halt required 452
   block calls to locate height 800. Bisection fallback after two slow probes
   reduces this to 12 with the identical exact result. Uniform timelines keep the
   two-block-request fast path; equal timestamp runs select the last matching
   block. The largest observed production repair run used 956 `/block` requests
   for 24 buckets, but the synthetic improvement is not a measured production
   savings claim.

Validation: 563 backend tests passed, zero failed (11 SQL-dependent checks skipped
without a database). Eight new PostgreSQL checks passed separately after applying
all 64 migrations to a disposable cluster. They verify repair completion, complete
scheduled-row protection, atomic provenance replacement, invalid incoming-height
protection, and proof reuse across connections. Backend import boundaries and
`git diff --check` pass. Production remains on the previously inspected release;
no commit, push, migration, timer change, or deployment was performed.

## Deployment follow-up

Backend and frontend deployed on September 5 as `39937587909bacd32d5f95d2c6e2d3fb27bd76e6`. The isolated release excluded unrelated unpublished work. GitHub CI run 33956709810 passed; the clean release passed 309 frontend tests, 526 backend tests, and eight PostgreSQL integration checks. Type checking reported zero errors and 56 existing warnings. All 16 production API performance gates passed, and production browser checks verified the paused churn label, white System Income POL metric, nonzero-only orange history, and five default 30-day chart ranges.

The optional historical repair prime still encountered Liquify HTTP 500 responses (Too many hops). Cached dashboard data remains healthy and the normal repair timer can retry; deployment does not establish that the historical backlog has been repaired.
