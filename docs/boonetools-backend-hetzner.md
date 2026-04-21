# BooneTools Backend on Hetzner

BooneTools now has a dedicated Hetzner-hosted backend stack for all current DB-backed features:

- `bond-history`
- `nodeop-performance`
- `nodeop-leaderboard`
- `nodeop-meta`
- `rapid-swaps`
- `stock-prices`
- local scheduler jobs for NodeOp and Rapid Swaps
- the rapid-swap listener writing directly into the local DB

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
```

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
5. Installs/restarts the backend API, schedulers, backup timer, and listener

It also refuses to run unless the current checkout is the canonical BooneTools repo with `origin` set to `https://github.com/erebuskaimoros/boonetools.git`.

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
