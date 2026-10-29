# BooneTools Deployment

Deploy an explicit, CI-passing commit from any checkout or linked worktree of
`https://github.com/erebuskaimoros/boonetools.git`. The local branch can be
detached or dirty: local edits are never packaged, reset, or stashed.

After committing/pushing the intended changes and waiting for that commit's
GitHub Actions `verify` check:

```bash
npm run boonetools:deploy:backend -- <commit-sha>
npm run boonetools:deploy:frontend -- <commit-sha>
```

Run only the component that changed; deploy backend first when both change.
No separate release clone or repeated full local test/build sequence is needed.
CI owns the complete verification suite; use focused local tests during development.
The guard fetches production main, requires the selected commit to belong to its
history, and verifies that commit's latest Actions `verify` result. There is no
dirty-tree or skip-CI bypass. Run from this repo, not the outer THORChain workspace.

## What a deploy does

Both entrypoints package the selected Git object and use the remote activation
helper from that same commit. Both retain checksums, the shared deployment lock,
immutable releases, atomic cutover, and automatic rollback on failed health checks.

The backend compares the current release with the selected artifact:

- Ordinary code changes restart only affected long-running processes, using
  their relative module dependencies in both the old and new source trees.
  Existing scheduled jobs finish normally and load the new release on their
  next scheduled run. There is no blanket warmup or historical backfill.
- Schema, dependency manifests, database scripts, or systemd/Docker manifest
  changes coordinate the services. Existing active work is resumed; inactive
  backfills and intentionally disabled timers remain inactive. Newly added
  timers and persistent services are enabled.
- Only new migrations run. Rewriting/removing historical migrations is rejected.
  Migrations must remain backward compatible: application rollback does not undo SQL.
- Checks cover local API health, affected DB-backed public endpoints, and
  restarted persistent services/timers. Deploy-only changes use Status as the
  DB-backed smoke check. Stale cached data is reported as a warning; normal
  collectors recover freshness independently. Unrelated websites and provider
  backfills are not deployment gates. Full performance/freshness testing remains
  available through `npm run perf:smoke`.
- At least three releases are retained by default, plus the rollback target and
  any older release still used by a running process. A failed activation can
  reuse its fully staged, checksum-matching artifact without overwriting it.

The printed backend plan is also saved as `DEPLOY_PLAN` in the release.
For a local, read-only comparison of two extracted source trees:

```bash
node scripts/backend-deploy-plan.mjs /path/to/previous /path/to/next
```

The frontend runs `npm ci` and its production build in an automatically created
temporary directory containing only the selected commit. It validates asset
paths, switches atomically, and compares a public hashed asset against the
staged file. Local `.env` files are not copied; the default API base is the
same-origin `/functions/v1`. Export any intentional `VITE_*` build overrides
explicitly. Server-owned backend secrets are never uploaded.

The STO widget's browser-visible affiliate key is read over SSH from
`/opt/boonetools-frontend/config/sto-widget-api-key` unless
`VITE_STO_WIDGET_API_KEY` is explicitly exported. Store only the key in that file,
owned by root with mode 0600 in a mode-0700 configuration directory; never commit
its value. The loader from the selected commit exports only this setting and
rejects missing/empty/whitespace-containing keys before building. It never sources
server configuration as shell code. The built widget exposes the affiliate key
to browsers by design; this file must not contain a backend credential.

Frontend packaging uses `COPYFILE_DISABLE=1` and `tar --no-xattrs` on both
BSD/macOS and GNU/Linux tar. This excludes AppleDouble files and extended
attribute headers without changing asset contents or suppressing extraction
errors. The deployment-source tests exercise real macOS metadata and GNU tar
when those implementations are available.

## Production layout

| Component | Location |
| --- | --- |
| SSH | `root@boone.tools` |
| Backend | `/opt/boonetools-backend/current` |
| Backend configuration | `/opt/boonetools-backend/config/backend.env` |
| Frontend releases | `/var/www/boone-tools-releases/releases/<commit>` |
| Frontend public directory | `/var/www/boone-tools` |
| Website | [boone.tools](https://boone.tools/) |

Defaults can be overridden with `SERVER`, `DEST`, and `KEEP_RELEASES` (minimum 2).
Frontend also accepts `VERIFY_URL` (HTTPS).
Application deploys do not change or reload host-wide Caddy configuration.
Do not bypass the release lock and rollback with a manual production rsync.
Host Node updates are separate from application artifacts; see
[security maintenance](security-maintenance.md) for the reviewed dependency
baseline, residual SDK advisories, and runtime restart/verification requirements.

A fresh backend installation still needs server-owned configuration and initial
data acquisition. Routine deployment does not populate a cold database or prove
historical completeness; provision/bootstrap new features deliberately. See
[backend operations](./boonetools-backend-hetzner.md) for feature-specific jobs.

### Dedicated Midgard endpoint

Keep Liquify Portal credentials only in the protected server environment. Append
`/v2` to its supplied HTTPS endpoint and set `MIDGARD_URL`, `MIDGARD_URLS`,
`RUJIRA_BASE_FEES_MIDGARD_URLS`, and `RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS`
consistently; explicit list overrides otherwise retain their previous providers.
Financials (including day rankings) and Protocol Comparison select the Midgard
service with relative routes, resolved by the shared backend service adapter.
Rujira lists inherit the resolved `MIDGARD_URLS` when no explicit override is set;
Rapid receives the same resolved backend configuration. Runtime-neutral modules and
browser bundles must not receive the key; standalone browser lookups stay public.

Back up the environment with its protected permissions, validate one bounded
health read, then restart affected persistent collectors under the release
workflow. Scheduled jobs load settings on their next run; let active jobs finish.
Do not reset historical caches, cursors, request budgets, or public-provider
cooldowns. Dedicated requests retain the shared admission limits and existing
dedicated breaker scope, independent of public-gateway throttling. Error messages,
gateway bodies, URLs and nested causes are redacted before persistence or public
source-error publication. Sensitive API-key/authorization headers are also redacted
if an upstream error echoes them. RPC and WebSocket settings are separate and unchanged.

The provider consolidation changes no migrations, cadences, cache schemas, request
budgets or archive ordering. Deploy backend before frontend, let ordinary collectors
resume, and check the configured service routes and DB-backed Financials/comparison/
TC Fee endpoints. Do not trigger historical scans as a smoke test. TC Fee's CMC and
DeFiLlama requests now use the common backend transport with 30-second deadlines,
Retry-After, durable cooldowns and endpoint-family metrics.

### NEAR net-supply methodology rollout

Deploy the backend before the frontend. The comparison's existing raw cache is
preserved; do not run the first-install seed script over it. Start the existing
`boonetools-protocol-fee-comparison.service` deliberately to acquire the new
UTC supply boundaries. If the 20-minute budget defers acquisition, a subsequent
run resumes verified pairs. Do not interrupt an already-running collector.
The old public snapshot remains intact until the full boundary window is ready.
Verify `nearIssuanceMethod=onchain-utc-net-supply-v1`, methodology v3, all monthly
coverage, and daily `incomeUsd - subsidyUsd = netUsd` before calling the
methodology migration complete. The six-hour timer then maintains it normally.
No database migration or cache reset is required. See
[the accounting note](../knowledge/protocol-fee-comparison.md#near-net-supply-methodology--september-28-2026).

## Troubleshooting

### Browser-local timestamp display

The October 25 timezone change is frontend-only. Deploy through the frontend
guard, then reload Financials and POL: freshness, hourly axes/tooltips and
snapshot times should use the browser timezone. H must still select 24H.
Daily/weekly/monthly accounting dates remain UTC; cached observations, request
windows and aggregation are unchanged. No backend deploy, migration, cache
reset or provider warmup is required. See
[the display contract](../knowledge/local-time-display.md).

### TC Fee pool-share chart

Deploy backend before frontend. The additive `feeComposition` field in the existing
`tc-fee-dash:v1` read model is built from cached earnings pool lists and reconciled
Pool Analysis daily fees. No migration, provider request, history reset or new
timer is required. Allow normal analytics publication (with the fee model's
five-minute minimum refresh interval) to expose the new field. Verify that recent completed days have four bucket amounts summing
to `totalFeesUsd`, and that incomplete historical attribution remains unavailable
rather than an estimated "other" share. See [the accounting note](../knowledge/tc-fee-dash.md#pool-fee-composition).

### Pool Analysis short-history coverage

Coverage starts at the earliest durable sync/refresh tracking day, not the first
row still present in a selected window. A new pool with every expected day
recorded therefore no longer triggers the missing-history warning merely
because it has fewer than thirty days of history. Earlier tracked days,
internal/trailing gaps, unknown anchors, sync errors and stale sources remain
visible. Exact rolling windows, amounts and annualization rules are unchanged.

Deploy backend only. No migration, backfill, provider request or history reset
is required for this read-model correction. After the next ordinary publication
(or a provider-free read-model rebuild under the existing Pool Analysis lock),
check that ZEC reports nineteen observed/expected completed days with zero
missing days, while retaining `requested_days=30`, its exact amounts and source
cutoff. `coverage.short_history` and `history_start_day` disclose why the
expected span is shorter. Existing frontend coverage handling removes both the
summary warning and the per-row missing-history highlight without a UI release.

### Pool Analysis refresh alignment

The timer runs at `:02`, `:17`, `:32`, and `:47` UTC: two minutes after each
quarter-hour source boundary, with 30-second scheduling accuracy. The former
activation-relative cadence could publish a thirteen-minute-old source window,
which crossed the unchanged twenty-minute freshness limit before the next run.
Calendar alignment leaves aggregation and ordinary job-runtime headroom without
adding routine requests or relaxing freshness. Provider lag, failed acquisition,
or unusually long jobs can still produce a truthful stale warning.

Deploy backend only through the normal release guard; the changed systemd unit
uses the coordinated activation path. No migration, environment/budget change,
cache reset, backfill, or manual collector run is needed. Check the installed
unit with `systemctl cat boonetools-pool-analysis.timer`, validate its calendar
with `systemd-analyze calendar '*-*-* *:02,17,32,47:00 UTC'`, and confirm the
timer's next trigger follows that grid. `Persistent=true` retains one missed
calendar catch-up after downtime; there is no separate startup trigger.
Let normal scheduled runs publish, then verify successful acquisition and fresh
rolling `window_end` values through the following scheduled publication. Use
the source-window timestamp as well as the read model's publication timestamp.

### Pool Analysis missing 24H window recovery

Deploy backend then frontend through the guarded release commands. No migration,
environment change, timer change or historical backfill is required. Let the next
ordinary Pool Analysis refresh recover missing 24H starting prefixes. Each repair
is one exact bounded request, saved for reuse, with existing provider limits intact.
Verify that recovered rows have `window_mode=rolling`, `snapshot_ready=true`, and
`window_end - window_start = 24 hours`; compare fees with the exact source window.
Failed recovery must retain truthful completed-day bounds and a visible fallback
notice in the table. Check a saved boundary is reused without another acquisition.
See [the incident and recovery contract](../knowledge/pool-analysis.md#missing-rolling-boundaries--october-28-2026).

### Pool Analysis same-window refresh

Cached quarter-hour heads and derived midnight zero heads retain swap-source
provenance before the daily upsert. This fixes repeat refreshes failing the
`pool_analysis_daily.source` non-null constraint and falsely marking saved
rolling observations stale. Deploy backend only through the normal release
guard; no SQL migration, cache reset, historical backfill or timer/configuration
change is required. Existing completed days remain immutable.

Verify two ordinary Pool Analysis refreshes within the same quarter-hour source
window. The second should reuse saved prefixes without new live swap-history
requests, keep the public response fresh, and report no source-field errors.
Bounded recovery of genuine missing historical days may still make requests;
do not mistake those for refetching the current prefix. See
`knowledge/pool-analysis.md#reused-snapshot-provenance--october-20-2026`.

### NativeSwap HTTP fallback

Deploy backend before frontend. No migration, cache reset, or backfill is
required. Shared THORNode and HTTP RPC clients include Liquify and
`https://public-thornode.nativeswap.io` and
`https://public-thorchain-rpc.nativeswap.io`, respectively. This includes core
snapshots, browser clients, Rapid Swaps THORNode reads, Rujira HTTP RPC, POL,
node-vote RPC, and Financials RPC/reward batches. Midgard is unchanged.

The October 17 concurrent-provider rollout distributes supported current GETs
and read-only RPC work between the configured Liquify and NativeSwap partners.
Each HTTP batch stays intact. Rujira base-fee/reserve and Financials reward
collectors fetch two independent batches per window, drain both, then persist
serially. Existing parallel consumers use the same dispatcher. Per-run history
budgets are unchanged; this is not a blanket rate-limit increase.

NativeSwap RPC `/status` is coalesced and cached for 60 seconds. Only a fresh,
synced `thorchain-1` node receives heights inside its advertised retention.
Unbounded searches and old RPC ranges stay on the configured archive path.
Historical REST retains ordered fallback and domain checks; coherent core
snapshots stay source-pinned. Midgard, WebSockets, writes, and unrelated APIs
are not balanced. Unsupported endpoints are not added to explicit provider lists.

`THORCHAIN_PROVIDER_CONCURRENCY=6` bounds active requests per gateway per backend
process (browser default: 4); public Liquify API/RPC share a lane, and dedicated
credentials have a separate lane. This is not a global cross-process quota.
The existing SQL circuit breakers remain cross-process, with 60-second failure
and one-hour quota cooldowns and `Retry-After` floors. Both providers retain
failover, cancellation, queue bounds, and exact-height checks. Financials' 650ms
RPC start spacing is now per provider, independent of its Midgard queue.
Set `THORCHAIN_PROVIDER_BALANCING_ENABLED=false` to restore backend ordered
selection and serial collector windows while retaining cooldown protection.
Transport callers may explicitly request `providerMode: 'fallback'`.

Run `node scripts/verify-thorchain-provider-pool.mjs` for bounded live reads:
it verifies overlapping two-item RPC batches on both public providers and
simulates a Liquify 503 only in its own process to check NativeSwap failover.
It neither changes server configuration nor writes shared cooldown state.

Before activation, check DNS and bounded `/thorchain/pools`, RPC `/status`, and
`/block_results` requests from the production host. Preserve dedicated/private
providers and archive ordering. Explicit `THORNODE_URLS`, `RPC_REST_URLS`,
`POOL_DISLOCATION_THORNODE_URLS`, `POL_TRACKER_THORNODE_URLS`,
`POL_TRACKER_RPC_URLS`, `NODE_VOTES_RPC_URLS`, `RUJIRA_BASE_FEES_RPC_URLS`, and
`RUJIRA_RESERVE_PAYMENTS_RPC_URLS` override defaults: append the corresponding
NativeSwap URL if these are set, rather than replacing custom providers.

Local live checks on October 16, 2026 verified mainnet HTTP reads, recent block
queries, browser-origin CORS, and one-/two-item `block_results` POST batches.
NativeSwap unwraps one-item batches; reward acquisition normalizes matching IDs
while retaining exact-height validation. RPC advertised earliest height
27,984,001 at inspection, so old history must remain unavailable when pruned.
The WebSocket handshake at `/websocket` returned HTTP 400; it is not configured
as a fallback. Do not infer WebSocket or full-archive support from HTTP success.

Frontend NativeSwap GETs omit the optional `x-client-id` header because its
preflight was rejected (HTTP 403), while simple cross-origin GETs allow `*`.
The local Vite fallback proxy uses the same provider, bounded transport, and
unchanged query paths. After rollout verify overlapping successful reads on both
providers and exercise simulated failures locally; do not disable Liquify in production
just to test failover. Historical height/gap checks and provider cooldowns remain
in force. Archived, unreachable UI components and standalone research scripts
are outside this runtime change.

### POL total rolling averages

The October 16 total-average addition is frontend-only. Reload POL Tracker and
open ROLLING AVGS: TOTAL should be first, with independent 7D/30D/90D choices.
These use all daily deposits (including hidden and unattributed pools), not
cumulative balances. Check RUNE/USD and D/W/M; averages retain daily historical
prices and off-screen lookback, with incomplete windows unavailable. Pool stacks,
the cumulative line, and existing pool averages are unchanged. No migration,
cache rebuild, backfill, or backend deployment is needed.

### Affiliate whitelist-change markers

The October 15 marker update is frontend-only. It reads the existing
`node-votes?view=vote&key=DYNAMICFEE-WHITELIST-{NAME}` effective history; no
backend deployment, migration, historical refetch or cache reset is needed.
Direct protocol events take precedence over duplicate same-state reconstructed
consensus entries. Older consensus-only entries remain explicitly estimated;
raw individual votes and current values never create marker dates. The API's
retained-history limit and fetch failures are disclosed without blocking metrics.

After reloading ADR26, verify EJ's September 25 addition and SYMBIOSIS's
addition/removal/re-addition in the six-month view. Switch D/W/M and drag to zoom:
lines should follow the actual UTC event position inside each bucket, disappear
outside the viewport and return on reset. SS's July 3 consensus estimate is
before a one-month view, so that view shows context below the chart rather than
an incorrectly positioned line. Existing fee/volume accounting is unchanged.

### Affiliate trend fees differ from transaction totals

Midgard earnings groups may contain slash-separated affiliate names such as
`ns/ss`. The affiliate trend includes routes containing the selected name,
matching its volume and transaction sources. Sum each matching earnings group
once; do not add the response aggregate again or include unrelated affiliates.
Preserve Midgard's display-USD valuation and the separate historical RUNE/USD
valuation used for fee rates. This is affiliate-tagged flow, not proof that
every historical swap used a dynamic fee floor.

The October 15, 2026 reconciliation fix is frontend-only: existing snapshots
already contain the co-listed groups. No backend deploy, cache reset, migration,
or refetch is required. Reload ADR26 and verify the SS October 12 bucket includes
all nine transactions, totaling 157.0696314 RUNE in protocol liquidity fees.
Display USD may change with Midgard's valuation; the chart and transaction sum
must agree apart from per-row display rounding.

### Cached comparison legacy history restoration

Deploy backend before frontend, then run the comparison job with
`rebuildOnly: true` under its normal advisory lock. This republishes the saved
acquisition cache without source requests, cache resets, migrations or historical
block backfills. Preserve source freshness metadata. Check that canonical exact
daily values and NEAR/Chainflip values match the pre-release snapshot, that the
separate `thorchain.legacy` object appears only before October 7, 2026, and that
its signed residual reproduces the cached original calculation. After frontend
activation, explicitly reload Financials: Full history should be selected with
the full twelve-month-plus-current window, and Latest verified must still exclude
legacy history. The subsequent user-requested numbers-only presentation removes
visible accounting labels and explainers without changing these data contracts;
deploy that presentation change frontend-only, with no cache rebuild. See
[the restoration contract](../knowledge/protocol-fee-comparison.md#cached-legacy-history-restoration--october-14-2026).

### Reserve emissions / REVSHARE accounting rollout

Deploy backend before frontend. Migration 067 creates the independent reward
ledger; the existing chain listener captures new finalized observations and the
Financials collector repairs October 7 onward in bounded batches. Keep existing
Financials and comparison caches intact. Verify a completed day publishes
nonnegative `reserveEmissionsRune`, separate `revshareRune`, and
`reconciliationAdjustmentRune`, with `rewardAccounting.complete=true`.
The sum `fees + emissions - REVSHARE + adjustment` must equal reported income.
Older unsupported periods remain unavailable in canonical exact fields rather
than using Midgard's signed `blockRewards` residual as emissions. The separately
stored historical comparison data described above does not change that rule.
After repair, rebuild the comparison from
its saved acquisition cache (`protocol-fee-comparison` with `rebuildOnly: true`)
under its normal advisory lock, or allow its normal timer to refresh it.
Check methodology v4 and retain NEAR/Chainflip coverage; missing canonical exact
THORChain monthly evidence is expected. See [accounting and archive limits](../knowledge/financials.md#reserve-emissions-and-revshare-october-13-2026).

### Financials day rankings and RUNE price line

Deploy backend before frontend. Migration 068 adds `financials_day_details`; the
existing Financials collector gains its bounded day-detail queue loop. Preserve
the current Financials acquisition cache and reward ledger. No new timer, full
history backfill, or provider warmup is required. Check that `financials?day=`
returns promptly with loading/progress metadata on a cold date and then the two
top-ten lists after collector completion. Invalid/future dates must return 400.
Verify daily clicks open the tables, drags still zoom, and the amber line defaults
to RUNE/USD with a working Bonding APR switch that preserves zoom.

The October 18 request-efficiency follow-up adds migration 069's shared Midgard
admission counters. Deploy backend first, preserving migration 068's saved payloads
and cursors. Completed closed-day snapshots must return `refreshing=false` even
with pending exclusions and must not reacquire the whole day. Untracked historical scans
require a recent two-minute visitor lease, resume saved cursors, and honor budget/cooldown
retry times. Today advances by new action intervals rather than rescanning its
completed prefix. Exact completed pool days reuse Pool Analysis's existing rows.

Production defaults enable `MIDGARD_REQUEST_BUDGET_ENABLED`. Public/default
providers are capped at 60/minute, 2,000/hour and 20,000/UTC day overall;
`/actions` and day-detail work share a bulk subset capped at 30/minute,
1,000/hour and 5,000/UTC day. Configured HTTPS Liquify Portal Midgard credentials
use 180/minute overall and 60/minute bulk, with the same hourly/daily ceilings.
The Portal long-window defaults inherit explicit `MIDGARD_REQUEST_BUDGET_*`
settings unless separately overridden. Configuration names are in
`backend/.env.example`. These are our safety caps, not a published Liquify quota.
Do not clear provider cooldowns or request counters on deployment.
No warmup, cold-date smoke scan, new timer or cache rebuild is required. Use saved
completed days for cached API verification, and inspect
`midgard_request_budgets` plus the Financials minute acquisition log. A first
uncached busy day can take tens of minutes under the shared bulk cap.

#### Background daily rosters (October 22, 2026)

Migration 072 adds durable background-maintenance metadata without deleting or
rewriting existing day payloads, action cursors, or provider deadlines. Deploy
backend before frontend. The existing Financials loop seeds today's UTC roster
without a visitor, adopts an existing incomplete yesterday row, and finishes
already tracked days after rollover. It does not enqueue the entire past or
start a new historical backfill. Older untracked dates retain visitor leases.

Background rosters reuse their saved top ten and scan only the next action
interval after a complete prefix. Quarter-hour horizons have a three-minute
settling allowance so Pool Analysis's normal `:02/:17/:32/:47` publication can
supply the latest UTC-day pool prefix at `through`. Pools in
`pool_analysis_sync_state` cost no provider request: reads rank their Pool
Analysis daily row (closed day) or latest prefix at or before `through` over the
stored list. Only untracked (for example delisted) pools use the budgeted provider.
Completed days stop acquisition permanently after the verified horizon reaches
the next UTC midnight. Pending/unpriced exclusions remain visible: sealing the
acquired window is not a claim that all late settlements were resolved.

No new service/timer, rate-limit increase, budget reset, cache reset, or history
rebuild is required. The initial current-day roster can still need a one-time
scan and may wait on an existing quota deadline. Subsequent visits read the
stored lists while background progress continues, including with no open tab.
Validate migration 072, current-day background ownership, saved progress across
collector restart, closing-day completion, and zero reacquisition of sealed
days. Check that today's top pools match Pool Analysis and the existing Midgard
budget counters. Do not trigger cold historical dates as a deployment smoke test.

#### Targeted pending settlement (October 24, 2026)

Deploy backend before frontend. No migration, new service, cache reset, quota
change or historical backfill is required. Existing closed snapshots with saved
pending transaction IDs enter a bounded settlement lane automatically. Each step
queries only one retained ID, persists the updated ranking and cursor, and keeps
the acquired horizon and pool totals unchanged. Normal provider cooldowns and
the shared bulk budget remain authoritative; do not clear them to accelerate
the initial pass. Still-unresolved passes back off by one hour, six hours, then
24 hours. Completed snapshots with no actionable IDs make no source requests.

Verify a known cached day through `financials?day=`: `settlement.status` should
show pending while retained IDs remain, and `checkedAt` advances after a complete
pass. Compare pool totals and `through` before/after, check cursor persistence
across ordinary restart, and confirm lookups use `txid` rather than full-day
pagination. Legacy count-only/overflow and unpriced exclusions remain provisional;
do not describe them as settled or trigger a full scan to eliminate the warning.
The frontend shows saved-status wording and polls only the cached API during
settlement. Validate source/budget deferrals and resolved-day polling shutdown.

Migration 070 adds a durable, per-credential start-time gate for Portal requests:
200ms between admissions across all backend processes (5/s, below the observed
Free plan's 10/s ceiling). Short pacing waits are abortable and bounded; waiting
does not spend quota or record a provider failure. Hour/day/minute exhaustion
still defers work with its reset time. Existing counter identities, totals,
cooldowns, saved observations and cursors survive the migration. Public-provider
admission and the old migration-069 function remain compatible with rollback.

This is a burst-only adjustment for the 44-pool sweep competing with other jobs,
not an increase to sustained hourly/daily allowances or permission to use a paid
plan. The account's October 19 current-plan display reported 100,000/day,
300,000/month and 10/s; the public pricing table differed on the daily allowance.
The portal aggregate also included historical RPC usage, so do not treat that
total as current Midgard-key traffic. These per-key minute/hour/day counters do
not certify remaining account-wide monthly quota. See
`knowledge/midgard-portal-limits-2026-10-20.md` for evidence and verification.

After frontend activation, reload and verify closed snapshots without actionable
settlement work stop polling, budget deferrals show a resume time with saved progress, and hidden/closed
panels stop renewing their leases. If an incident temporarily held specific queue
rows by `available_at`, release only those exact holds after the fixed collector
is active; preserve any newer retry deadlines and all payload/state/cooldown data.

#### Hourly Financials (October 25, 2026)

Deploy the backend before the frontend. No migration or new service/timer is required.
The Financials process adds bounded hourly acquisition and independently
publishes `financials:hour:30d:v1`. Preserve both `history-v1.json` and the new
`hourly-v1.json` in its existing StateDirectory. Normal shared request budgets
and cooldowns apply; do not reset them or force an hourly warmup/backfill.

Verify the cached `financials?bucket=hour&range=24h` response, hourly timestamp
identity, explicit partial-hour coverage, and no provider calls from public
GETs. `[H]` must reset to 24H; hourly presets cap at 30D, and D/W/M continue to
use daily history. Hourly APR is deliberately absent. Check restart reuse of
completed hours, missing intervals, UTC rollover and budget-deferred retries.

### Crosschain comparison stuck at a shared date

Check the public `protocol-fee-comparison` endpoint's `errors` and the
`boonetools-protocol-fee-comparison.service` journal before blaming the timer.
An unknown Chainflip runtime or changed pinned code hash fails issuance closed,
which holds all protocols at their last shared complete UTC day. Review the
official source and deployed mint events before admitting a new runtime; see
[the October 19 review](../knowledge/protocol-fee-comparison.md#october-1519-2026-runtime-20219-review).
Runtime 20219 is admitted only for its verified deployed code hash; its source
review and mint-event evidence cover the October 15 upgrade. Later runtimes
and different code under the same version still require their own review.
After deploying the reviewed backend, start the existing service if it is idle
and let its saved acquisition cache fill the gaps. Do not reset the cache or
run concurrent collectors. Verify `throughDay` advances, source errors clear,
and affected monthly coverage becomes complete. No frontend release is needed
for a runtime-allowlist-only fix.

### POL share of total pool depth

The headline card needs schema-7 `system-income-pol:v1`. Deploy backend before
frontend and allow the normal two-minute reconciliation to capture total
two-sided core pool depth in the existing state JSON. Verify
`summary.total_pool_depth_rune_e8` is positive and that the displayed percentage
is `total_position_value_rune_e8 / total_pool_depth_rune_e8 * 100`, rounded to
one decimal. No migration, cache reset, or backfill is required; older snapshots
show an unavailable value rather than an invented percentage.

### POL recipient breakdown rollout

The October 3 recipient-pool chart requires the schema-6 `system-income-pol:v1`
snapshot. Deploy the backend first, then let the existing two-minute SIPOL job
publish it from stored pool/day history. Verify `daily[].pool_deposits` sums to
each day's `deployed_e8` (including the live tail) before deploying the frontend.
No migration, reseeding, cache reset or new backfill is required. Old snapshots
remain compatible and render as Unattributed until the upgraded snapshot arrives.

A refused deploy identifies missing CI, an unpublished commit, a wrong origin,
or an already-active/conflicting release. A fully staged release can be retried;
an incomplete staging directory requires inspecting the failure before removing
that exact directory. Never overwrite a release that a running process uses.

For service diagnostics:

```bash
ssh root@boone.tools 'systemctl status boonetools-api'
ssh root@boone.tools 'journalctl -u boonetools-api --since "10 min ago"'
```

After a frontend change, hard refresh to load new hashed assets. If routing itself
is unhealthy, inspect Caddy independently rather than changing it in an app deploy.

### Thorfolio operator-fee churn column

Deploy the backend (including migration `071_bond_operator_fees.sql`) before the
frontend. `bond_history.operator_fee` is nullable RUNE base units, independent of
bond rewards and stack. It comes from the operator's empty-transaction
`bond_returned` event paired with that node's `bond_reward` in the churn block;
historical node ownership and a nonzero operator fee are checked before attribution.
It is never reconstructed using today's fee rate. Ordinary unbonds and subsequent
provider yield returns are excluded. Missing/pruned or ambiguous event evidence
stays unavailable rather than becoming zero.

The existing bond-history worker enriches at most 25 cached rows per pass, newest
first, updating only `operator_fee`. Successful bounded passes requeue without
consuming failure attempts. RPC failures use the existing retry/cooldown policy.
Compact, height-verified payout observations are shared across addresses in the
immutable acquisition cache. No history deletion, timer change, new credentials,
or manual full-history rebuild is needed. Until enrichment completes the frontend
shows a dash for unverified fees; zero is shown only after a verified churn scan.
Current node operators and addresses with historical operator payouts receive the
column (and matching CSV/XLS field); provider-only views omit it.
