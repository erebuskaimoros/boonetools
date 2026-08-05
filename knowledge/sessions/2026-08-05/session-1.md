# Session 1 - Consolidated Chain Stream

> Date: 2026-08-05
> Focus: Consolidate Liquify block-event ingestion and ship every-block status telemetry

## Summary

Consolidated BooneTools' duplicate THORChain block subscriptions behind one durable Liquify listener, database-backed replay, and same-origin SSE relay. The status chart now renders every block interval with live updates and zoom, the payload-complete Rujira and clock consumers share the same stream, and both backend and frontend releases are live in production.

## Papercuts

- Resolved: None
- Deferred: `pc-20260805-153306-2143b1` and `pc-20260805-151549-a8e8e1` are external Liquify gateway cache/error behavior; `pc-20260804-203213-82b5e5` and `pc-20260804-202939-bbdfc3` require a dedicated PostgreSQL migration harness; `pc-20260804-204153-4600b2` is a production deploy-gate design change; `pc-20260804-173720-b6a917`, `pc-20260804-172554-22bc55`, `pc-20260804-165608-ffcf08`, and `pc-20260804-165534-017afe` concern Codex tooling outside this repository.
- Remaining open: 9

## Work Done

- Audited 26 canonical site data flows: 2 are fully websocket-replaceable, 16 are hybrid, and 8 are unrelated; the parser can improve 20 of 22 backend acquisition pipelines.
- Replaced three full-block backend listeners and two direct browser sockets with one consolidated Liquify `NewBlock` parser plus the existing narrow node-vote transaction subscription.
- Added a 48-hour block-header store, initial 24-hour bootstrap, bounded five-minute gap repair, compact replay API, PostgreSQL notification broker, and reconnecting SSE endpoint.
- Migrated block intervals, ADR26's epoch clock, Rujira Reserve payments, generated base fees, and Limit Orders invalidation hints onto the shared stream while preserving authoritative reconciliation paths.
- Reworked the status chart to draw approximately 14,400 daily block intervals as one SVG path with nearest-point hover and drag zoom.
- Deployed backend release `b87ad8e8761b-unverified-20260805T205036Z` and frontend release `b87ad8e8761b-unverified-20260805T205204Z`; production health, performance, replay, SSE, service, and historical-repair checks passed.

## Discoveries

- Five payload-complete live lanes can share a single full `NewBlock` payload, but most site datasets remain hybrid because block events should invalidate or advance authoritative REST, Midgard, Dune, market, or wallet models rather than replace them.
- A durable websocket architecture needs committed headers, replay, and repair in addition to SSE; browser EventSource alone is not a lossless transport.
- A full day of roughly 14,400 blocks is inexpensive to render when the chart uses one path and a single active hover marker instead of one DOM target per block.
- The production repair restored 15,000 headers across 750 bounded RPC ranges with zero deferred ranges, and live SSE continued from the repaired history.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/043_chain_block_headers.sql` | Added durable block headers and chain-stream state |
| `backend/src/listener.js`, `backend/src/chain-stream-listener.js` | Consolidated block ingestion, persistence, parsing, hints, and repair |
| `backend/src/shared/chain-headers.js`, `backend/src/shared/chain-stream.js` | Added normalized block contracts, bulk repair, and event adaptation |
| `backend/src/handlers/block-production.js`, `backend/src/lib/chain-event-broker.js`, `backend/src/server.js` | Added compact replay and same-origin SSE routes |
| `backend/src/shared/block-production.js`, `backend/src/jobs/status-dashboard-scheduler.js` | Derived compatibility rollups from stored block headers |
| `backend/src/rujira-base-fees-listener.js`, `backend/src/rujira-reserve-listener.js` | Removed superseded dedicated listeners |
| `ops/systemd/`, `scripts/deploy-boonetools-backend-remote.sh`, `scripts/rapid-swap-listener.service` | Installed the consolidated service and removed obsolete units |
| `src/lib/api/chain-stream.js`, `src/lib/status/api.js`, `src/lib/status/block-production-chart.js` | Added frontend stream/replay adapters and per-block chart helpers |
| `src/lib/status/BlockProductionChart.svelte` | Shipped every-block replay, live healing, hover, and drag zoom |
| `src/lib/DynamicFeeDashboard.svelte`, `src/lib/LimitOrders.svelte` | Replaced direct Liquify sockets with the site-owned EventSource |
| `backend/tests/chain-headers.test.js`, `backend/tests/block-production.test.js`, `tests/chain-stream-api.test.js`, `tests/status-block-production-chart.test.js` | Covered parser, repair, broker, API, consumer, and rendering contracts |
| `knowledge/liquify-websocket-consolidation.md`, `knowledge/status-dashboard.md`, `docs/boonetools-backend-hetzner.md` | Recorded the flow census, architecture, operations, and deployment behavior |

## In Progress

None - session complete

## Next Steps

- [ ] Monitor chain-stream reconnects, repair statistics, and retained-header coverage over the first 24 hours.
- [ ] Confirm Rujira Reserve and generated-base-fee reconciliation remains gap-free after retiring the dedicated listeners.
- [ ] Watch SSE connection counts and API latency as clients adopt the production frontend.
- [ ] Revisit hybrid consumers only where event invalidation materially reduces provider polling.
