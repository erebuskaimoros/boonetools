# Session 1 - BooneTools Hetzner Backend Cutover + Live Deploy

> Date: 2026-04-01
> Focus: Replace the Supabase runtime path for BooneTools DB-backed features with a Hetzner-hosted Postgres/API stack and deploy it live on `boone.tools`

## Summary

Built and deployed a dedicated Hetzner-hosted BooneTools backend stack covering `bond-history`, `nodeop-*`, `rapid-swaps*`, and `stock-prices`, while keeping the public `/functions/v1/*` contract stable for the frontend. Seeded the new Postgres instance from Supabase, switched Caddy and the frontend to `https://boone.tools/functions/v1`, removed the old Hetzner rapid-swaps cron, and brought the new listener plus systemd timers online.

## Work Done

- Added a new Node/Postgres backend workspace under `backend/` with direct Postgres handlers for the existing BooneTools function surface.
- Ported the Supabase SQL schema into canonical Postgres migrations for NodeOp, Rapid Swaps, and Bond History.
- Added Hetzner deployment/runtime assets: Docker Compose for a dedicated `boonetools-postgres`, Caddy config, systemd units, DB migration/backup/restore scripts, and a single backend deploy script.
- Switched the rapid-swap listener and scheduler paths away from Supabase writes to the local Postgres-backed runtime.
- Added a Supabase import tool and a backend compare tool to seed and verify the Hetzner stack before cutover.
- Fixed two rollout bugs during deployment:
- The deploy script was deleting the remote backend `.env` on reruns, which rotated DB credentials against a persistent Postgres volume.
- JSON-valued columns needed explicit serialization in the Postgres bulk upsert helper to import and schedule correctly.
- Updated timestamp formatting in the backend to match Supabase-style UTC strings with `+00:00`.
- Deployed the backend/API live on Hetzner, exposed it at `https://boone.tools/functions/v1/*`, rebuilt the frontend against that origin, and synced the static bundle live.
- Removed the legacy root Hetzner rapid-swaps cron entry and enabled the new systemd timers and listener as the primary runtime path.

## Discoveries

- A `rsync --delete` deploy into a live backend directory is unsafe if the remote `.env` is authoritative; excluding `.env` is required to avoid silent credential rotation.
- Postgres `jsonb` columns cannot reliably accept raw JavaScript arrays/objects through the generic upsert helper unless the helper explicitly stringifies configured JSON columns.
- Caddy needed an explicit `route` block so `/functions/v1/*` would win before the SPA `try_files` fallback.
- The old-vs-new `rapid-swaps` diff reduced to numeric precision drift and fresh runtime metadata, not missing rows or broken endpoint shape.
- The listener/service cutover should stop old schedulers before import, then start the new timers only after the seed and Caddy/frontend switch are complete.

## Files Changed

| File | Change |
|------|--------|
| backend/package.json | Added the Hetzner BooneTools backend workspace and runtime scripts. |
| backend/src/server.js | Added the local HTTP service for the BooneTools function surface. |
| backend/src/handlers/bond-history.js | Ported Bond History to direct Postgres with write-on-read cache behavior. |
| backend/src/handlers/nodeop-performance.js | Ported NodeOp performance reads to Postgres. |
| backend/src/handlers/nodeop-meta.js | Ported NodeOp backend metadata reads to Postgres. |
| backend/src/handlers/nodeop-leaderboard.js | Ported leaderboard reads to Postgres plus live THORNode merge logic. |
| backend/src/handlers/rapid-swaps.js | Ported rapid-swaps reads/metadata to Postgres. |
| backend/src/handlers/stock-prices.js | Kept stock-prices as a thin backend helper endpoint. |
| backend/src/jobs/nodeop-scheduler.js | Added the local NodeOp scheduler with advisory locking. |
| backend/src/jobs/rapid-swaps-scheduler.js | Added the local rapid-swaps scheduler with advisory locking. |
| backend/src/listener.js | Added the Postgres-backed rapid-swap websocket listener. |
| backend/src/import-supabase.js | Added a seed/import path from Supabase REST into local Postgres. |
| backend/src/compare-backends.js | Added contract verification between Supabase and the new backend. |
| backend/src/db/sql.js | Added JSON-column serialization support for generic inserts/upserts. |
| backend/src/lib/utils.js | Normalized UTC timestamp formatting to Supabase-compatible `+00:00`. |
| backend/migrations/*.sql | Added canonical BooneTools Postgres migrations. |
| ops/caddy/Caddyfile.boone.tools | Added the live `boone.tools` proxy route for `/functions/v1/*`. |
| ops/docker/boonetools-postgres.compose.yml | Added the dedicated BooneTools Postgres container definition. |
| ops/systemd/* | Added BooneTools API, scheduler, backup, and listener systemd units/timers. |
| scripts/deploy-boonetools-backend.sh | Added the Hetzner backend deploy script and hardened it against `.env` deletion and DB init races. |
| scripts/boonetools-db-migrate.sh | Added canonical Postgres migration application on Hetzner. |
| scripts/boonetools-db-backup.sh | Added nightly Postgres dump backup with retention. |
| scripts/boonetools-db-restore.sh | Added Postgres restore workflow for backups. |
| scripts/rapid-swap-listener.mjs | Repointed the listener entry to the new backend runtime. |
| scripts/deploy-listener.sh | Repointed legacy listener deploys to the new unified backend deploy path. |
| scripts/nodeop-backend-deploy.sh | Repointed legacy backend deploys to the new unified backend deploy path. |
| docs/boonetools-backend-hetzner.md | Documented the new BooneTools Hetzner backend architecture and operations. |
| docs/deployment.md | Updated deployment documentation for the split static/backend runtime. |
| .env.example | Switched frontend runtime defaults to `https://boone.tools/functions/v1`. |
| package.json | Added backend test/compare/deploy scripts. |

## In Progress

- Supabase remains available as a rollback source during the initial live observation window, but it is no longer the active BooneTools runtime path.

## Next Steps

- [ ] Monitor the Hetzner backend, listener, and systemd timers for the 48-hour rollback window.
- [ ] Decommission remaining Supabase runtime dependencies and legacy deploy assumptions after the rollback window.
- [ ] Add a tighter compare normalization for `rapid-swaps` numeric precision so future cutover checks stay quiet.
- [ ] Run a restore drill from `/var/backups/boonetools-postgres` onto a scratch Postgres instance.
- [ ] Commit and push this cutover session once the repo state is staged cleanly.
