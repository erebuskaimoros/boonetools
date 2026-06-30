# BooneTools Backend on Hetzner

BooneTools now has a dedicated Hetzner-hosted backend stack for all current DB-backed features:

- `bond-history`
- `nodeop-performance`
- `nodeop-leaderboard`
- `nodeop-meta`
- `rapid-swaps`
- `stock-prices`
- local scheduler jobs for NodeOp and Rapid Swaps
- Dune-backed historical/canonical ingestion with THORNode/Midgard live tails where current data matters

## Layout

- API service: `backend/src/server.js`
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
VITE_NODEOP_API_BASE=https://boone.tools/functions/v1
VITE_RAPID_SWAPS_API_BASE=https://boone.tools/functions/v1
```

Public GETs continue to accept:

- `apikey: <PUBLIC_API_KEY>`
- `Authorization: Bearer <PUBLIC_API_KEY>`

## Local / Server Runtime Env

Start from `backend/.env.example` and set at least:

```bash
PORT=8787
DATABASE_URL=postgresql://boonetools:...@127.0.0.1:5433/boonetools
PUBLIC_API_KEY=...
THORNODE_PRIMARY_URL=https://thornode.thorchain.network
THORNODE_FALLBACK_URL=https://thornode.thorchain.liquify.com
MIDGARD_URL=https://midgard.thorchain.network/v2
MIDGARD_FALLBACK_URL=https://midgard.liquify.com/v2
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

1. Syncs backend code, shared rapid-swap modules, scripts, and ops assets to `/opt/boonetools-backend`
2. Installs backend dependencies
3. Starts the dedicated Postgres container
4. Applies canonical DB migrations
5. Installs/restarts the backend API, schedulers, and backup timer

When `RAPID_SWAPS_DUNE_QUERY_ID` is configured, deploy disables the legacy
`rapid-swap-listener.service`; the scheduler live tail is the fresh-data path.

After deploy, install the Caddy config in `ops/caddy/Caddyfile.boone.tools` if the API proxy is not already live.

## Data Import

To seed or refresh the Hetzner DB from the existing Supabase project:

```bash
set -a
source .env
source backend/.env
set +a
node backend/src/import-supabase.js
```

Optional full replacement import:

```bash
BOONETOOLS_IMPORT_REPLACE=1 node backend/src/import-supabase.js
```

## Shadow Verification

Compare the old Supabase responses to the local Hetzner backend:

```bash
npm run backend:compare -- --node-address thor... --bond-address thor...
```

Defaults:

- old base: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1`
- new base: `http://127.0.0.1:8787`

## Notes

- GitHub workflow cron is no longer the source of truth for DB-backed jobs.
- Hetzner cron wrappers should remain disabled once the systemd timers are active.
- The listener and schedulers rely on Postgres advisory locks / durable tables rather than Supabase-specific runtime features.
