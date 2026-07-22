# Session 1 - Live Status Updates

> Date: 2026-07-22
> Focus: Low-latency production updates for the Status dashboard

## Summary

Added and deployed a compact live Status data lane so current THORChain network, chain, node, and churn values update every 15 seconds without repeating expensive dashboard work. The browser conditionally polls only while visible, catches up on focus, and merges live values without resetting the block-production chart or its zoom state.

## Work Done

- Added the `status-live:v1` read model, DB-only public handler, conditional revalidation, and a 15-second systemd publisher.
- Refactored the one-minute Status publisher to consume the same current-network read model instead of repeating THORNode and Midgard requests.
- Merged live values into the existing dashboard while retaining the one-minute cadence for block history, stuck transactions, and node-vote history.
- Added frontend, backend, model, route, scheduler, deployment, and performance-budget regression coverage.
- Updated deployment and performance documentation, deployed both backend and frontend, and verified that production height advanced automatically across a polling interval.

## Discoveries

- The previous one-minute browser poll was layered on a one-minute publisher, allowing almost two minutes of worst-case visible latency.
- A small independently published read model delivers visibly live data without accelerating expensive stuck-transaction or historical block scans.
- Production served the fresh 818-byte compressed live payload in 5 ms during the release gate.

## Files Changed

| File | Change |
|------|--------|
| `shared/status/model.js` | Added the reusable compact network read-model builder and shared it with the full dashboard model. |
| `backend/src/shared/status-live.js` | Defined the live read-model key, schema, TTL, and database access. |
| `backend/src/handlers/status-live.js` | Added the DB-only public endpoint with ETag revalidation and freshness headers. |
| `backend/src/jobs/status-live-scheduler.js` | Added the lock-protected 15-second publisher job. |
| `backend/src/jobs/status-dashboard-scheduler.js` | Reused the live network model in the full Status publisher. |
| `backend/src/run-job.js` and `backend/src/server.js` | Registered the job and public route. |
| `src/lib/status/api.js` | Added the live endpoint adapter. |
| `src/lib/StatusDashboard.svelte` | Added visible-tab polling, focus catchup, safe model merging, and live freshness display. |
| `ops/systemd/boonetools-status-live.service` and `.timer` | Added production publisher units at a 15-second cadence. |
| `ops/systemd/boonetools-status-dashboard.service` | Declared the live snapshot dependency for the full publisher. |
| `scripts/deploy-boonetools-backend.sh` and `scripts/perf-smoke.mjs` | Installed, primed, and performance-gated the new lane. |
| `backend/tests/analytics-jobs.test.js` and `backend/tests/status-dashboard.test.js` | Added job, handler, scheduler, and deployment coverage. |
| `tests/boonetools-api.test.js` and `tests/status-model.test.js` | Added frontend API and compact-model coverage. |
| `docs/boonetools-backend-hetzner.md` and `docs/performance-architecture.md` | Documented cadence, architecture, and release budgets. |

## In Progress

None - session complete

## Next Steps

- [ ] Monitor `boonetools-status-live.timer` and read-model freshness during normal production load.
- [ ] Watch Status endpoint latency and provider request volume to confirm the expected efficiency gain over time.
- [ ] Address the existing Svelte accessibility and unused-selector warning backlog separately.
