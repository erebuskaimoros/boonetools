# BooneTools Backend on Hetzner

BooneTools now has a dedicated Hetzner-hosted backend stack for all current DB-backed features:

- `bond-history`
- `nodeop-performance`
- `nodeop-leaderboard`
- `nodeop-meta`
- `rapid-swaps`
- `stock-prices`
- `app-layer-base-layer-earnings`
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

The public `/functions/v1/stuck-transactions` endpoint powers the `/status` dashboard's high-confidence stuck-payment list. It composes current THORNode queue and transaction-stage state behind a 30-second in-process cache; it requires no database migration or additional environment variable.

The public `/functions/v1/network-snapshot` endpoint coalesces Status dashboard
reads behind one short-lived cache. THORNode fields and Midgard churns fail
independently, so a churn outage does not erase healthy node/Mimir state. A
forced refresh retains the previous snapshot as stale fallback if every
provider is unavailable.

The public `/functions/v1/node-votes` payload includes one deduplicated
`active_nodes` roster from the same THORNode state used for current vote
rollups. The Vote Tracker compares that roster with each key's current voter
addresses so a consensus shortfall can list active node operators that have no
current vote without repeating the full roster inside every vote-key row.

The public `/functions/v1/app-layer-base-layer-earnings` endpoint powers lane
01 of the App Layer dashboard. Migration `023_rujira_base_layer_earnings.sql`
stores one midnight balance baseline and one replaceable accrual row per UTC
day. `boonetools-app-layer-live-state.timer` refreshes the current row every
two minutes from the existing live-state snapshot; no second timer or new env
variable is required. `backend/data/rujira-base-layer-inflows.json` supplies
the immutable historical bootstrap, and DB rows override matching seed days.

## Local / Server Runtime Env

Start from `backend/.env.example` and set at least:

```bash
PORT=8787
DATABASE_URL=postgresql://boonetools:...@127.0.0.1:5433/boonetools
PUBLIC_API_KEY= # optional legacy client token, not a secret
THORNODE_PRIMARY_URL=https://gateway.liquify.com/chain/thorchain_api
THORNODE_FALLBACK_URL=https://thornode.thorchain.network
MIDGARD_URL=https://gateway.liquify.com/chain/thorchain_midgard/v2
MIDGARD_FALLBACK_URL=https://midgard.thorchain.network/v2
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
```

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

## Deploy

```bash
npm run boonetools:deploy:backend
```

That script:

1. Snapshots the current backend/shared tree and quiesces writer timers and listeners
2. Syncs backend code, the neutral `shared/` domain package, scripts, and ops assets to `/opt/boonetools-backend`; production does not copy or import frontend `src/` modules
3. Installs backend dependencies and starts the dedicated Postgres container
4. Applies each canonical DB migration and its applied marker in one transaction
5. Installs/restarts the backend API, schedulers, Bond History refresh worker, and backup timer; the App Layer live-state prime also writes the current lane 01 accrual row

If deployment exits after writers are quiesced, the EXIT trap restores the
snapshotted backend/shared tree and starts the previous writer set.

Cached Bond History requests enqueue one refresh per address and scope in
`bond_history_refresh_queue`. `boonetools-bond-history-refresh.timer` drains
that queue every minute. Normal request handlers never perform historical
provider scans, including on cold misses: they return `202` until the worker
has materialized a cache row. The frontend polls `refresh=status`, which reads
the cache without re-enqueueing work or disturbing retry backoff.

Migration `026_event_provenance.sql` gives Rapid Swaps, node votes, and Rujira
Reserve payments a unique canonical identity plus per-provider observation
history. Canonical upserts enforce source precedence and monotonic first/last
seen timestamps atomically in Postgres.

When `RAPID_SWAPS_DUNE_QUERY_ID` is configured, deploy disables the legacy
`rapid-swap-listener.service`; the scheduler live tail is the fresh-data path.

After deploy, install the Caddy config in `ops/caddy/Caddyfile.boone.tools` if the API proxy is not already live.

## Notes

- GitHub workflow cron is no longer the source of truth for DB-backed jobs.
- Hetzner cron wrappers should remain disabled once the systemd timers are active.
- The listener and schedulers rely on Postgres advisory locks and durable tables.
