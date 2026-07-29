# BooneTools Backend on Hetzner

BooneTools now has a dedicated Hetzner-hosted backend stack for all current DB-backed features:

- `bond-history`
- `nodeop-performance`
- `nodeop-leaderboard`
- `nodeop-meta`
- `rapid-swaps`
- `stock-prices`
- `app-layer-base-layer-earnings`
- compact Status, Treasury, Node Votes, App Layer, Rapid Swaps, TC Fee, and
  Wasm Arb Economics read models
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
current vote without repeating the full roster inside every vote-key row.

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

The public `/functions/v1/wasm-arb-economics` endpoint serves the corrected v2
Wasm intervention ledger without request-time provider calls. Its scheduled
job rebuilds duplicate-safe Midgard action volume, discovers RUJI Trade fees
through Tendermint `tx_search` and `block_search`, scans canonical
`block_results`, prices otherwise unsupported FIN denoms through a
same-transaction execution rate, and samples pool/oracle prices at matching
heights. Independent source flags keep cash-flow and price-quality conclusions
provisional until their backfills are complete.

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
THORNODE_FALLBACK_URL=https://thornode.thorchain.network
THORNODE_URLS=
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
MIDGARD_FALLBACK_URL=https://midgard.thorchain.network/v2
MIDGARD_URLS=
RPC_REST_URL=https://gateway.liquify.com/chain/thorchain_rpc
RPC_FALLBACK_REST_URL=https://rpc.thorchain.network
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
`/status-live`, `/status-dashboard`, `/treasury-snapshot`, `/node-votes-summary`, and
`/rapid-swaps-summary`; the established Node/Rapid routes remain compatibility
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

Migrations `031_wasm_arb_economics.sql` and
`032_wasm_arb_economics_accounting.sql` own the Wasm dashboard. Migration 032
adds FIN market metadata, spread interventions, and same-height oracle samples;
it clears only derived action/block/fee caches and invalidates prior dashboard
snapshots so the corrected v2 read model cannot mix old and new accounting.

Rapid-Swap websocket ingestion is disabled by default in the shared
`rapid-swap-listener.service`, while Node-Vote websocket ingestion remains
enabled. The deploy keeps that shared process running whenever either lane is
enabled; the Rapid scheduler/live tail remains its normal fresh-data path.

The host-wide `/etc/caddy/Caddyfile` is owned and deployed independently by Web
Ops because it also serves MemeMap, The AI Guys, webmail, traffic reports, and
Landlord. BooneTools application deploys do not modify or reload Caddy. They
verify every public route after activation and must never install the app-only
`ops/caddy/Caddyfile.boone.tools` over the host-wide file.

## Notes

- GitHub workflow cron is no longer the source of truth for DB-backed jobs.
- Hetzner cron wrappers should remain disabled once the systemd timers are active.
- The listener and schedulers rely on Postgres advisory locks and durable tables.
