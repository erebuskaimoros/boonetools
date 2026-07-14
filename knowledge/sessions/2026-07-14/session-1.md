# Session 1 - Live Base Layer Earnings Backend

> Date: 2026-07-14
> Focus: Restore near-real-time backend accounting for App Layer lane 01

## Summary

Restored lane 01 of the App Layer dashboard to the existing two-minute backend live-state path instead of treating a checked-in artifact as current data. The backend now persists UTC-day opening balances and replaceable current-day earnings rows, while the frontend polls the merged API series and retains the artifact only as historical bootstrap and outage fallback.

## Work Done

- Traced repository history and confirmed that the May 17 live-state backend survived, but the July 12 dashboard refactor introduced lane 01 as an artifact-only series.
- Added migration 023 for daily weighted collector-balance baselines and Base Layer earnings rows.
- Added `/app-layer-base-layer-earnings` and connected its refresh to `boonetools-app-layer-live-state.timer` every two minutes.
- Preserved the accounting identity: scoped collector transfers, internal conversions, and Reserve payouts cancel; only newly accrued app-layer value increases lane 01.
- Switched the frontend to backend-first loading, two-minute polling, unified manual refresh, stale warnings, and static fallback behavior.
- Made the historical generator recompute recent days incrementally so routine refreshes do not require indefinite archive-node retention.
- Regenerated the historical bootstrap through July 14; completed July 13 now measures $1,106.26 instead of the stale partial-day $226.18.
- Added backend accounting/header/JSON-parameter tests, refreshed documentation, and verified 154 tests plus the production build.

## Discoveries

- Commit `170206b` introduced the live App Layer backend on 2026-05-17; commit `fc3b205` made the new lane 01 chart read `rujira-base-layer-inflows.json` on 2026-07-12.
- The Rujira Trade page is narrower than BooneTools lane 01: it reports RUJI Trade, while BooneTools includes the configured Base Layer allocation from both RUJI Trade and Other Core Apps.
- Liquify's current Thornode API retains recent historical state but not the April baseline height, so routine artifact generation must retain verified older rows and recompute a bounded recent window.
- Historical balance requests require forwarding `x-cosmos-block-height`; the shared Thornode client previously discarded caller-provided headers.
- Node-postgres treats JavaScript arrays as Postgres array parameters, so arrays destined for `jsonb` columns must be explicitly `JSON.stringify`-serialized.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/023_rujira_base_layer_earnings.sql` | Added persisted UTC-day baselines and replaceable earnings rows. |
| `backend/src/shared/rujira-base-layer-earnings.js` | Added weighted live accounting, baseline capture, DB upserts, and seed/DB API merging. |
| `backend/src/handlers/app-layer-base-layer-earnings.js` | Added the public lane 01 API handler. |
| `backend/src/jobs/app-layer-live-state-scheduler.js` | Refreshes lane 01 after each live-state snapshot. |
| `backend/src/shared/thornode.js` | Forwards historical height headers. |
| `backend/data/rujira-base-layer-inflows.json` | Added backend-owned historical bootstrap. |
| `src/lib/AppLayerBaseLayerDashboard.svelte` | Uses the live endpoint, polls every two minutes, and falls back safely. |
| `scripts/rujira-base-layer-inflows.mjs` | Added recent-window regeneration, endpoint fallback, and synchronized backend seed output. |
| `public/data/rujira-base-layer-fees/*` | Refreshed public fallback through July 14. |
| `backend/tests/rujira-base-layer-earnings.test.js` | Tests route weights, conservation movements, fresh accrual, and merged totals. |
| `README.md`, `docs/`, `knowledge/`, `ops/systemd/` | Documented runtime ownership, deployment, accounting, and timer scope. |

## In Progress

Production deployment is queued immediately after this session commit: backend first, then frontend, followed by live endpoint and page verification.

## Next Steps

- [ ] Deploy the backend so migration 023, the endpoint, and the current-day scheduler row are live.
- [ ] Verify the production lane 01 API is fresh and its current day is DB-owned.
- [ ] Deploy the frontend after the endpoint is healthy.
- [ ] Verify the production page consumes the backend and refreshes without artifact/stale warnings.
- [ ] Monitor the first UTC rollover to confirm the new midnight baseline is captured correctly.
