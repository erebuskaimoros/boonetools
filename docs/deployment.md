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

A fresh backend installation still needs server-owned configuration and initial
data acquisition. Routine deployment does not populate a cold database or prove
historical completeness; provision/bootstrap new features deliberately. See
[backend operations](./boonetools-backend-hetzner.md) for feature-specific jobs.

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

### Crosschain comparison stuck at a shared date

Check the public `protocol-fee-comparison` endpoint's `errors` and the
`boonetools-protocol-fee-comparison.service` journal before blaming the timer.
An unknown Chainflip runtime or changed pinned code hash fails issuance closed,
which holds all protocols at their last shared complete UTC day. Review the
official source and deployed mint events before admitting a new runtime; see
[the October 12 review](../knowledge/protocol-fee-comparison.md#september-30october-12-2026-runtime-review-gap).
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
