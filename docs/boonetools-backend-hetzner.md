# BooneTools Backend on Hetzner

BooneTools now has a dedicated Hetzner-hosted backend stack for all current DB-backed features:

- `bond-history`
- `nodeop-performance`
- `nodeop-leaderboard`
- `nodeop-meta`
- `rapid-swaps`
- `currency-rates`
- `stock-prices`
- `app-layer-base-layer-earnings`
- compact Status, Treasury, Node Votes, App Layer, Rapid Swaps, TC Fee, Pool
  Analysis, and Wasm Arb Economics read models
- local scheduler jobs for NodeOp and Rapid Swaps
- Dune-backed historical/canonical ingestion with THORNode/Midgard live tails where current data matters

## Layout

- API service: `backend/src/server.js`
- Runtime-neutral domain core: `shared/rapid-swaps/` and `shared/blockchain.js`
- DB schema: `backend/migrations/`
- Dedicated Postgres container: `ops/docker/boonetools-postgres.compose.yml`
- systemd units/timers: `ops/systemd/`
- Caddy config with `/functions/v1/*` proxy: `ops/caddy/Caddyfile.boone.tools`
- Deploy script: `scripts/deploy-boonetools-backend.sh`
- DB tools:
  - `scripts/boonetools-db-migrate.sh`
  - `scripts/boonetools-db-backup.sh`
  - `scripts/boonetools-db-restore.sh`

## Public API Base

Frontend/runtime env should point to:

```bash
VITE_BOONETOOLS_API_BASE=https://boone.tools/functions/v1
VITE_BOONETOOLS_API_KEY=
```

The frontend uses one BooneTools API origin and optional public client token for every feature.
Legacy feature-specific `VITE_*_API_BASE` and `VITE_*_API_KEY` variables are
accepted only as migration aliases.

Every read-only route is public and protected by the backend request limiter.
The optional browser-visible token is retained for compatibility and client
identification only; it is not authentication. Existing clients may continue
to send:

- `apikey: <PUBLIC_API_KEY>`
- `Authorization: Bearer <PUBLIC_API_KEY>`

Successful legacy responses gain additive contract metadata. Request the v2
`{ data, meta }` envelope using `?schema_version=2` or the media type
`application/vnd.boonetools.v2+json`.

The public `/functions/v1/stuck-transactions` endpoint powers the `/status`
dashboard's high-confidence stuck-payment list. The scheduled scanner fetches
only the four queue surfaces, reuses current network/Mimir/constants/inbound
state from `thornode-core:v1`, and persists status/details by transaction and
queue fingerprint. Unchanged queue entries therefore require no repeated
per-hash provider calls.

The public `/functions/v1/network-snapshot` endpoint is provider-free. It reads
the durable `thornode-core:v1` model published by
`boonetools-thornode-core-snapshot.timer`. THORNode fields use mixed cadences
based on volatility and retain their last successful value independently. A
Midgard-only result can never be published as a fresh network snapshot when
all due THORNode work failed.

The public `/functions/v1/node-votes-summary` payload includes one deduplicated
`active_nodes` roster from the same THORNode state used for current vote
rollups. The Vote Tracker compares that roster with each key's current voter
addresses so a consensus shortfall can list active node operators that have no
current vote without repeating the full roster inside every vote-key row. The
same publisher overlays THORNode's live upgrade proposals and active-validator
approval state, while the listener and hourly backfill retain indexed
`approve_upgrade` and `reject_upgrade` events as `UPGRADE-*` history. Upgrade
quorum counts only active approvals; rejects remain visible stances and can
never become the passing value. The additive `network_values` field reuses the
same durable THORNode core snapshot to publish every current Mimir and every
typed constant, with independent completeness and source-update timestamps;
the frontend never fetches those provider routes directly.

The public `/functions/v1/dynamic-fee-transactions` endpoint powers the
click-to-inspect ADR26 epoch drawer. Midgard supplies the matching action list,
then THORNode RPC swap events supply the selected pair leg's actual
`liquidity_fee_in_rune` and RUNE volume inside that epoch. Sealed responses are
cached for 90 days because their underlying block events are immutable; live
responses use a 15-second cache. This avoids assigning Midgard's whole-route
fee to every pair in double, streaming, or affiliate-conversion swaps.

The public `/functions/v1/dynamic-fee-affiliate-volume` endpoint supplies
canonical affiliate trend volume. It derives route input notional from Midgard
actions, counts each pool in `action.pools` as one executed leg, and returns
both `legVolumeUsd` and the separate `routeVolumeUsd` presentation value.
Selected day, week, and month chart buckets can opt into the same bounded
action scan with `include_transactions=true`; those responses add
volume-sorted route details and whole-route liquidity fees without bloating the
default 400-day chart response. Transaction detail is capped at 31 days.
Responses use persistent and single-flight caches because this is a bounded
historical drill-down rather than a dashboard summary read model.

The public `/functions/v1/wasm-arb-economics` endpoint serves the corrected v3
post-Mimir-zero monitoring series without request-time provider calls. Recent
history is compacted hourly and older history daily while preserving additive
accounting, so the payload remains bounded as the series grows. Its scheduled
job rebuilds duplicate-safe Midgard action volume, discovers RUJI Trade fees
through Tendermint `tx_search` and `block_search`, scans canonical
`block_results`, prices otherwise unsupported FIN denoms through a
same-transaction execution rate, and samples pool/oracle prices at matching
heights. Independent source flags keep cash-flow and price-quality conclusions
provisional until their backfills are complete.

All Wasm ingestion and coverage begins at the verified Mimir-zero activation,
height `27181679` (`2026-07-27T14:04:45Z`). Fee collector discovery and
candidate-block retrieval have separate ordinary-failure RPC cooldown scopes;
confirmed gateway 429s remain global. Migration
`040_wasm_post_change_boundary.sql` removes legacy pre-change queue/data rows
and resets the `tx_search` backfill cursor because its page number is relative
to the requested height interval.

All backend volume producers follow
[`volume-accounting.md`](./volume-accounting.md): aggregates and fee-rate
denominators use executed-leg volume, while intentional route-notional display
values remain separate.

The public `/functions/v1/app-layer-base-layer-earnings` endpoint powers lane
01 of the App Layer dashboard. Migration `023_rujira_base_layer_earnings.sql`
stores one midnight balance baseline and one replaceable accrual row per UTC
day. `boonetools-app-layer-live-state.timer` refreshes the current row every
two minutes from the existing live-state snapshot; no second timer or new env
variable is required. `backend/data/rujira-base-layer-inflows.json` supplies
the immutable historical bootstrap, and DB rows override matching seed days.
The public request is served from `app-layer-base-layer-earnings:v1`; the
analytics publisher materializes it from those canonical rows.

The performance and freshness contract for every dashboard read model is in
[`performance-architecture.md`](./performance-architecture.md).

## Local / Server Runtime Env

Start from `backend/.env.example` and set at least:

```bash
PORT=8787
DATABASE_URL=postgresql://boonetools:...@127.0.0.1:5433/boonetools
PUBLIC_API_KEY= # optional legacy client token, not a secret
BOONETOOLS_PROVIDER_CLIENT_ID=BooneTools
PROVIDER_COOLDOWN_ENABLED=true
PROVIDER_FAILURE_COOLDOWN_SECONDS=60
PROVIDER_RATE_LIMIT_COOLDOWN_SECONDS=3600
THORNODE_PRIMARY_URL=https://gateway.liquify.com/chain/thorchain_api
THORNODE_URLS=
BIFROST_SCANNER_INFO_URL=https://vanaheimex.com/api/nodesInfo
BIFROST_SCANNER_INFO_TIMEOUT_MS=8000
BINANCE_API_BASE_URL=https://data-api.binance.vision
BINANCE_API_BASE_URLS=https://data-api.binance.vision
POOL_DISLOCATION_BACKFILL_REQUEST_DELAY_MS=100
POOL_DISLOCATION_BACKFILL_BATCH_BUCKETS=12
POOL_DISLOCATION_BACKFILL_RETRY_ATTEMPTS=8
POOL_DISLOCATION_BACKFILL_RETRY_BASE_DELAY_MS=1000
POOL_DISLOCATION_BACKFILL_RETRY_MAX_DELAY_MS=60000
POOL_DISLOCATION_THORNODE_URLS=https://gateway.liquify.com/chain/thorchain_api
POOL_DISLOCATION_SNAPSHOT_RETRY_ATTEMPTS=3
POOL_DISLOCATION_SNAPSHOT_RETRY_BASE_DELAY_MS=1000
POOL_DISLOCATION_CORE_FALLBACK_MAX_AGE_SECONDS=180
POOL_DISLOCATION_TRADING_FALLBACK_MAX_AGE_SECONDS=900
POOL_DISLOCATION_REPAIR_LOOKBACK_HOURS=168
POOL_DISLOCATION_REPAIR_MAX_BUCKETS=24
POOL_DISLOCATION_REPAIR_RETRY_ATTEMPTS=4
POOL_DISLOCATION_REPAIR_RETRY_BASE_DELAY_MS=500
POOL_DISLOCATION_REPAIR_RETRY_MAX_DELAY_MS=10000
MIDGARD_URL=https://gateway.liquify.com/chain/thorchain_midgard/v2
MIDGARD_URLS=
RPC_REST_URL=https://gateway.liquify.com/chain/thorchain_rpc
RPC_WS_URL=wss://gateway.liquify.com/chain/thorchain_rpc/websocket
RAPID_SWAPS_CANONICAL_SCAN_INTERVAL_SECONDS=900
RAPID_SWAPS_NORMAL_HEAD_PAGES=4
RAPID_SWAPS_LAGGING_HEAD_PAGES=2
RAPID_SWAPS_CATCHUP_PAGES=2
RAPID_SWAPS_RATE_LIMIT_COOLDOWN_SECONDS=3600
DUNE_API_KEY=...
RAPID_SWAPS_DUNE_QUERY_ID=7619996
RAPID_SWAPS_DUNE_SCAN_INTERVAL_SECONDS=21600
RAPID_SWAPS_LIVE_TAIL_INTERVAL_SECONDS=300
RAPID_SWAPS_LIVE_TAIL_PAGES=2
APP_LAYER_LIVE_STATE_TTL_SECONDS=120
APP_LAYER_STATIC_STATE_TTL_SECONDS=900
APP_LAYER_ROUTE_CONCURRENCY=4
WASM_ARB_ECONOMICS_ORACLE_START_HEIGHT=27164000
WASM_ARB_ECONOMICS_ORACLE_STRIDE_BLOCKS=30
WASM_ARB_ECONOMICS_ORACLE_SAMPLES_PER_RUN=40
```

`THORNODE_URLS`, `MIDGARD_URLS`, and `BINANCE_API_BASE_URLS` are optional
comma-separated ordered lists.
Use them to put a dedicated node or paid provider ahead of the public defaults
without changing application code. The older primary/fallback variables remain
the defaults when the list variables are empty.

`BIFROST_SCANNER_INFO_URL` supplies the compact five-minute scanner-health
snapshot used by the status page's `Avg Blocks Behind Tip` column. The default
is the same aggregate that backs `thorchain.net/nodes`. BooneTools retains only
the node address and per-chain scanner height, lag, and health fields. A failed
refresh reuses the last good scanner snapshot and surfaces a scoped warning;
it does not mark otherwise healthy THORNode state stale.

Authenticated Liquify Portal URLs belong only in the server-owned
`backend.env`; never commit their embedded API keys. A dedicated
`https://gateway.liquify.com/api=...` route has a redacted, independent
provider-cooldown scope, so a public gateway 429 cannot disable that endpoint.
Keep `RPC_WS_URL` on the public WebSocket route unless the Portal explicitly
supplies and verifies a dedicated WebSocket URL.

`POOL_DISLOCATION_THORNODE_URLS` is an independent ordered list for this
sampler and its historical repair. Add a second provider only after its DNS and
`/thorchain/pools` response have been verified from the production host. The
sampler retries transient pool failures inside the same exact five-minute
bucket, then may use the independently persisted `thornode-core:v1` pool field
for up to three minutes. Those degraded rows retain
`pool_price_method=thornode-core-snapshot` and are automatically replaced by
same-block historical reconstruction. Oracle and Binance requests use the
same bounded retry policy and bypass a stale shared provider cooldown after
their first transient failure. Recent last-known inbound-address state remains
usable for up to fifteen minutes, so a brief provider outage cannot re-expose
pools on halted chains; older or missing state still fails open. The repair
timer scans the trailing seven days every fifteen minutes and processes at
most 24 missing, degraded, or source-wide incomplete buckets per run. A reconstructed source that is
genuinely absent at its exact block or market interval is labelled
`thornode-oracle-unavailable` or `kline-close-unavailable`, so the repair is
idempotent without hiding the null reference. A source value that exists but
falls outside the 30-second alignment contract uses the corresponding
`*-unaligned` method instead and remains null in the dislocation series.

Rapid Swaps is hybrid in the Dune-backed deployment. Dune query `7619996`
remains the canonical source and runs on its own cadence, while the scheduler
also tails a small number of recent Midgard pages every few minutes for fresh
rows. The live tail upserts into `rapid_swaps`; later Dune scans overwrite the
same `tx_id` rows with canonical Dune values. Provider `429` responses store a
cooldown in `rapid_swap_sync_state` so timer runs skip without burning more
quota.

The server env also carries the dedicated Postgres container settings:

```bash
BOONETOOLS_DB_CONTAINER=boonetools-postgres
BOONETOOLS_DB_NAME=boonetools
BOONETOOLS_DB_USER=boonetools
BOONETOOLS_DB_PASSWORD=...
```

Production configuration is server-owned at
`/opt/boonetools-backend/config/backend.env`, with mode `0640` and ownership
`root:deploy`. Deploys never place secrets in SSH arguments or copy a local
`.env` over that file.

## Deploy

```bash
npm run boonetools:deploy:backend
```

That script:

1. Requires a clean `main` commit matching `origin/main` with a successful GitHub Actions `verify` check
2. Creates and checksums an immutable commit artifact
3. Acquires the server-wide BooneTools deployment lock
4. Stages code and production dependencies under `/opt/boonetools-backend/releases/<commit>`
5. Confirms the existing public baseline, quiesces writers, and applies backward-compatible migrations
6. Installs the release's exact systemd manifest and atomically switches `/opt/boonetools-backend/current`
7. Restarts listeners, primes read models, verifies that every timer has a future trigger, and runs API, performance, and all-domain health gates

If any post-switch gate fails, the deploy atomically restores the previous
release, reinstalls its unit manifest, restarts it, and verifies both API and
public-route health. At least three immutable releases are retained by default.
Migrations must use expand/contract compatibility because schema changes are
forward-only during application rollback.

Cached Bond History requests enqueue one refresh per address and scope in
`bond_history_refresh_queue`. `boonetools-bond-history-refresh.timer` drains
that queue every minute. Normal request handlers never perform historical
provider scans, including on cold misses: they return `202` until the worker
has materialized a cache row. The frontend polls `refresh=status`, which reads
the cache without re-enqueueing work or disturbing retry backoff.
Maintenance timers use `OnActiveSec` for their initial activation so restarting
them on a long-running host always produces a next trigger; `OnBootSec` must
not be used for deploy-restarted timers.

Scheduled jobs write one bounded JSON completion or failure record to the
journal. Job return payloads can contain whole provider snapshots and must not
be printed: the journal is duplicated into host syslog, so pretty-printing a
15-second job result can exhaust the server filesystem.

Migration `026_event_provenance.sql` gives Rapid Swaps, node votes, and Rujira
Reserve payments a unique canonical identity plus per-provider observation
history. Canonical upserts enforce source precedence and monotonic first/last
seen timestamps atomically in Postgres.

Migration `027_api_read_models.sql` adds the shared `api_read_models` snapshot
store and bounded publisher-run history. Migration
`028_analytics_read_paths.sql` adds the ordered/cursor indexes used by compact
summary and drill-down routes. The additive public routes are
`/status-live`, `/status-dashboard`, `/treasury-snapshot`, `/node-votes-summary`,
`/rapid-swaps-summary`, `/pol-tvl`, `/pol-tracker`, `/burn-tracker`, `/pool-analysis`, and
`/pool-analysis-series`; the established Node/Rapid routes remain compatibility
surfaces during frontend rollout but never contact providers on a GET.

`boonetools-thornode-core-snapshot.timer` publishes the canonical mixed-cadence
provider snapshot every 15 seconds. `boonetools-status-live.timer` is now a
database-only projection of that core model. The Status frontend conditionally
polls the compact status endpoint while visible and merges it with the
one-minute dashboard snapshot, without repeating current-network provider
requests.

Migration `030_thornode_efficiency.sql` adds shared provider circuit-breaker
state and persistent stuck-transaction lookup reuse. Production providers
should still be independently operated; configure a dedicated THORNode/RPC in
the server-owned environment when available. The shared cooldown prevents an
unreachable configured fallback from being retried by every oneshot process.

Migration `033_pool_dislocation_provenance.sql` records whether each exact
five-minute Pool Dislocation point came from the live sampler or historical
reconstruction and records each price method. After deploying that migration,
an operator can fill the seven days preceding the first scheduled point with:

```bash
systemctl start --no-block boonetools-pool-dislocation-backfill.service
journalctl -fu boonetools-pool-dislocation-backfill.service
```

The resumable service reads pool and oracle state at the same historical
THORChain block. Its Binance leg uses the matching five-minute kline close,
because the public Spot archive has no historical best-bid/best-ask stream.
It writes in bounded transactions, preserves any live row at a conflicting
timestamp, verifies every planned bucket, and refreshes the public read model.
It has no timer and does not run automatically during future deploys.

Migrations `046_pol_tracker.sql`, `047_pol_tracker_pool_breakdown.sql`, and
`056_pol_tvl_system_income_pol.sql` add daily and per-pool POL Tracker history,
including the legacy Reserve module's gross value and the separate System
Income-funded `pol_reserve` module position in each pool.
The `boonetools-pol-tracker.timer` samples the latest completed UTC day at
00:10 UTC and republishes `/pol-tvl`. Configure `POL_TRACKER_THORNODE_URLS`
with a historical-height THORNode endpoint and `POL_TRACKER_RPC_URLS` with an
archive RPC before starting the one-time February 2025 backfill:

```bash
systemctl start --no-block boonetools-pol-tracker-backfill.service
journalctl -fu boonetools-pol-tracker-backfill.service
```

The backfill is resumable by date and never interpolates a failed lane. Savers
and RUNEPool provider/Reserve ownership shares are excluded from the public
model. Provider-owned RUNEPool value remains a private database reconciliation
field. The gross legacy Reserve POL total comes from `runepool.pol.value`; its
per-pool rows apply THORNode's rounded safe-share calculation to Reserve-module
LP units and RUNE depth, double the share, and must reconcile to that total.
The System Income POL lane resolves the `pol_reserve` module and deposited-pool
LPs at the same historical anchor and values both sides using same-height pool
depth and RUNE/TOR price. It remains a distinct chart value to prevent the two
forms of POL from being conflated.
The public handler supplements that daily history with
`current.system_income_pol` from the cached `system-income-pol:v1` model. Its
headline USD value is rebuilt as the sum of the reconciled RUNE-leg and
asset-leg USD values; the historical chart remains completed-day and
same-height.

Scheduled and default backfill runs use `POL_TRACKER_HEAD_LAG_DAYS=0`, so the
target is the latest completed UTC day. Raise the value only when a configured
archive provider consistently trails day-end state; an explicit backfill end
date still overrides the lag. If the current scheduled target cannot be
resolved, the job first republishes the last-good model with an explicit
missing day, then exits unsuccessfully so systemd retries it every 15 minutes.
`/pol-tvl` compares its latest source day with that target, so republishing
old rows cannot reset the dashboard to healthy; `target_end_date`, coverage,
warnings, and `stale` expose the gap until the target day succeeds.

Migrations `054_system_income_pol.sql` and
`055_system_income_pol_headlines.sql` add the block-live System Income POL
ledger, daily and per-pool rollups, current positions, ownership samples, and
sync state. The latter enriches finalized reward events with the exact total
system-income denominator and persists the shared core RUNE/USD price for the
headline and position USD values. `boonetools-system-income-pol.timer` repairs missing block results
from the activation height and publishes `system-income-pol:v1` every two
minutes. The chain listener writes live reward/deployment events continuously;
the scheduler reconciles the `pol_reserve` module balance and deposited-pool LP
positions against `thornode-core:v1`, then derives ownership-weighted fee
estimates from `pool_analysis_daily`. `/pol-tracker` remains provider-free and
adds committed block events newer than its model watermark.

Optional controls are `SYSTEM_INCOME_POL_ACTIVATION_HEIGHT`,
`SYSTEM_INCOME_POL_REPAIR_BLOCKS_PER_RUN`,
`SYSTEM_INCOME_POL_REPAIR_CONCURRENCY`, `SYSTEM_INCOME_POL_LP_CONCURRENCY`, and
`SYSTEM_INCOME_POL_TIMEOUT_MS`. A deployment primes the publisher before the
public performance gate; subsequent repair is resumable and idempotent.

Migration `049_system_income_burn_tracker.sql` adds route-specific daily RUNE
burn history and resumable sync state. `boonetools-burn-tracker.timer` refreshes
the current UTC partial day, all-time reconciliation total, and public read
model every five minutes. Migration `050_system_income_burn_blocks.sql` adds
the exact `rewards.income_burn` amount to live block headers. `/burn-tracker`
overlays those committed post-snapshot blocks and the browser applies every
`/chain-events` height once, while the five-minute job remains the durable
reconciliation and backfill path. It reuses Mimir, constants, and bank supply
from the core snapshot. To force a complete rebuild from the first route day:

```bash
systemctl start --no-block boonetools-burn-tracker-backfill.service
journalctl -fu boonetools-burn-tracker-backfill.service
```

Optional configuration is `BURN_TRACKER_START_DATE` (default `2024-09-26`),
`BURN_TRACKER_RECENT_LOOKBACK_DAYS` (default `7`), and
`BURN_TRACKER_REQUEST_DELAY_MS` (default `250`). Both jobs use the configured
Liquify `MIDGARD_URLS`; no public request contacts Midgard or THORNode. The
per-block path reuses the existing consolidated Liquify websocket connection.

Migration `051_pool_analysis.sql` adds exact per-pool UTC swap volume,
pool-generated liquidity fees, and per-asset sync state. Migration
`052_pool_analysis_fee_scope.sql` removes the legacy downstream-earnings
column, discards rows that contain no swap measures, and normalizes retained
rows to swap-history provenance.
`boonetools-pool-analysis.timer` refreshes the trailing 35 days every fifteen
minutes and publishes the compact `/pool-analysis` table model. Its single
aggregate query materializes completed-UTC 24-hour, 7-day, 30-day, 90-day, and
1-year volume and liquidity-fee windows, including coverage and annualized
generated-fee rates. Current price, depth, and balances come from
`thornode-core:v1`; the core snapshot also retains
`/thorchain/oracle/prices` on the pool cadence. The lazy
`/pool-analysis-series?asset=...&range=30d|all` route reads at most 5,000
stored daily rows and never contacts a provider during a public request. Pool
Analysis stops at liquidity-fee generation; subsequent system-income
distribution is outside its data contract.

The table displays total two-sided liquidity from `total_depth_usd` and uses
that same total as the Volume/Depth and Fees/Depth denominator. Fees/Depth is
the selected period's generated liquidity fees divided by current total depth;
Est. APR annualizes that generated-fee rate. The compatibility field `depth_usd`
remains the one-sided RUNE-depth valuation.

Run the one-time all-pool historical fill separately from deployment:

```bash
systemctl start --no-block boonetools-pool-analysis-backfill.service
journalctl -fu boonetools-pool-analysis-backfill.service
```

The fill is advisory-locked against the scheduled writer, paginates Liquify
Midgard's 100-interval per-pool swap-history limit, writes bounded batches, and
can be safely started again. Missing provider days remain visible gaps; they
are never interpolated or treated as zero. Optional settings are
`POOL_ANALYSIS_START_DATE` (default `2021-04-01`),
`POOL_ANALYSIS_RECENT_LOOKBACK_DAYS` (default `35`),
`POOL_ANALYSIS_REQUEST_DELAY_MS` (default `100`),
`POOL_ANALYSIS_MAX_PAGES` (default `30`), and
`POOL_ANALYSIS_CONCURRENCY` (default `2`).

Migration `042_pool_dislocation_binance_usdt_to_usd.sql` corrects the Pool
Dislocation Binance unit contract. Binance spot markets provide `XUSDT`, so
the writer and historical repair multiply each raw quote by the same-snapshot
THORChain Oracle `USDT/USD` rate before storing it in the `*_usd` columns. The
migration first preserves the original provider values and conversion evidence
in `pool_dislocation_binance_usdt_archive`; missing or source-unaligned rates
produce null USD fields rather than mislabeled values. Deploy the corrected
writer before this forward data migration so the previous release remains a
safe rollback target.

Migrations `035_wasm_arb_economics.sql`,
`036_wasm_arb_economics_accounting.sql`,
`037_wasm_arb_monitoring_series.sql`, and
`040_wasm_post_change_boundary.sql` own the Wasm dashboard. Migration 036
adds FIN market metadata, spread interventions, and same-height oracle samples;
it clears only derived action/block/fee caches and invalidates prior dashboard
snapshots so the corrected v2 accounting cannot mix old and new data. Migration
037 invalidates the intervention-comparison snapshot before publishing the
bounded v3 monitoring contract. Migration 040 aligns storage, queueing, and
coverage with the post-change-only contract.

Wasm provider hardening is metadata-only and requires no migration. The three
scheduled lanes use `wasm-activity-head`, `wasm-fees-head`, and
`wasm-oracle-head` for ordinary THORNode head failures; the combined manual job
uses `wasm-combined-head`. Actual 429/`Retry-After` responses still open the
provider-wide breaker. Same-height pool snapshots with an empty Oracle payload
are evicted and retried three times, then—only when the following height has
valid sources—recorded in `oracle:backfill` `stats_json.gaps` and skipped
without interpolation. The public read model
reports both cursor completion and gap-free Oracle coverage. Deterministic
Midgard missing-depth-pool 400s are stored in `api_response_cache` for 24 hours
under `wasm-arb:missing-price-pool:*`; expiration safely re-probes for newly
available pools.

`boonetools-chain-stream-listener.service` is the single persistent THORChain
websocket process. It stores every block header, parses Rujira Reserve and
generated-base-fee events directly from the full `NewBlock` payload, retains
the existing Rapid Swap hint parser, and keeps the narrow Node-Vote transaction
subscription. Rapid-Swap websocket ingestion remains disabled by default and
its scheduler/live tail remains the normal canonical fresh-data path.

Migration `043_chain_block_headers.sql` owns the 48-hour raw header store and
durable stream cursor; migration `050_system_income_burn_blocks.sql` extends
live headers with exact system-income burn amounts. The listener automatically bootstraps approximately 24
hours and repairs retained gaps every five minutes through the configured
Liquify RPC endpoint. The API exposes compact replay at `/block-production`
and relays committed heads at `/chain-events`; the latter uses PostgreSQL
`LISTEN/NOTIFY`, SSE keepalives, and automatic client reconnection.

Migration `044_rujira_fee_share_settlements.sql` extends the App Layer payment
ledger with typed `reserve` and `pol` settlement rows. It preserves the direct
Reserve compatibility series, reparses scheduled blocks from the first split
payout at height `27410412`, and rewinds the cadence cursor so deployments fill
the post-cutover POL branch. The Reserve scheduler must continue its bounded
RPC block scan even after a successful Dune run because Dune query `7620011`
provides the Reserve branch, while scheduled block results provide POL-fund
transfers. Lane 01 conservation adds back both destinations.

Migration `045_correct_rujira_pol_fund.sql` corrects the full POL-fund target,
removes any rows associated with the incomplete target from migration 044, and
safely repeats the scheduled scan from height `27410412`.

The host-wide `/etc/caddy/Caddyfile` is owned and deployed independently by Web
Ops because it also serves MemeMap, The AI Guys, webmail, traffic reports, and
Landlord. BooneTools application deploys do not modify or reload Caddy. They
verify every public route after activation and must never install the app-only
`ops/caddy/Caddyfile.boone.tools` over the host-wide file.

## Notes

- GitHub workflow cron is no longer the source of truth for DB-backed jobs.
- Hetzner cron wrappers should remain disabled once the systemd timers are active.
- The listener and schedulers rely on Postgres advisory locks and durable tables.
