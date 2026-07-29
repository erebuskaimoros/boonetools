# Session 1 - Wasm Arb Economics Dashboard

> Date: 2026-07-29
> Focus: Provider-free Wasm arbitrage economics ingestion, read model, and dashboard

## Summary

Implemented a complete Wasm Arb Economics feature that compares equal windows around `WasmArbSlipMinBps` regime changes using executed-leg volume and attributable THORChain cash flow. The feature includes durable Postgres ingestion, a provider-free public read model, frontend charts and comparison metrics, production timer wiring, tests, and accounting documentation.

## Work Done

- Added migration-backed storage for job state, regimes, network buckets, Wasm actions, candidate blocks, and Rujira fee events.
- Built the incremental ingestion pipeline for Midgard action/network history, indexed collector transfers, canonical block-result attribution, and historical fee pricing.
- Added the compact analytics read model, API handler, five-minute job, configuration, registry wiring, deploy wiring, and systemd units.
- Added the `/wasm-arb-economics` dashboard with equal-window controls, cash-flow and efficiency charts, coverage diagnostics, and provisional verdict rules.
- Added shared domain math and frontend/backend tests covering normalization, attribution, transition-bucket exclusion, equal-window comparison, and incomplete-source handling.
- Verified 155 frontend tests, the full backend suite, frontend structural/Svelte checks, a production build, and the workspace ownership/push audit.

## Discoveries

- Executed-leg volume is the correct additive denominator: cross-asset routes count two pool legs, while route notional is presentation-only.
- Collector balance deltas cannot provide transaction-local attribution; indexed transfer discovery plus canonical `block_results` events captures FIN and AMM fee transfers and links them to Wasm executions.
- FIN range fees are a subset of FIN fees and must not be added twice. Missing block, transfer, network, action, or price coverage keeps the verdict provisional.
- The comparison is evidence about observed cash flow, not causal proof; equal complete windows and an excluded transition bucket keep the accounting boundary explicit.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/031_wasm_arb_economics.sql` | Added durable economics ingestion schema and initial verified Mimir regime. |
| `backend/src/shared/wasm-arb-economics-ingestion.js` | Added incremental chain ingestion, event attribution, pricing, and read-model publication. |
| `backend/src/shared/wasm-arb-economics.js` | Added database aggregation and compact dashboard payload construction. |
| `backend/src/handlers/wasm-arb-economics.js` | Added provider-free public API handler. |
| `backend/src/jobs/wasm-arb-economics-scheduler.js` | Added isolated scheduled job entry point. |
| `backend/src/lib/config.js` | Added Wasm economics ingestion configuration. |
| `backend/src/run-job.js` | Registered the scheduled job. |
| `backend/src/server.js` | Registered the API route. |
| `backend/src/shared/analytics-read-model-keys.js` | Added the read-model key. |
| `backend/src/shared/analytics-read-models.js` | Added refresh support for the economics payload. |
| `backend/.env.example` | Documented production configuration knobs. |
| `backend/tests/wasm-arb-economics.test.js` | Added ingestion and attribution tests. |
| `backend/tests/analytics-jobs.test.js` | Added scheduler/deploy registry coverage. |
| `shared/wasm-arb-economics/model.js` | Added shared bucket normalization, window comparison, metrics, and aggregation. |
| `src/lib/WasmArbEconomics.svelte` | Added the dashboard UI and coverage/verdict presentation. |
| `src/lib/wasm-arb-economics/api.js` | Added the frontend API adapter. |
| `src/lib/wasm-arb-economics/charts.js` | Added cash-flow and efficiency charts. |
| `src/lib/wasm-arb-economics/model.js` | Re-exported the runtime-neutral domain model. |
| `src/App.svelte` | Added route and navigation integration. |
| `tests/wasm-arb-economics.test.js` | Added shared comparison-model tests. |
| `ops/systemd/boonetools-wasm-arb-economics.service` | Added the production oneshot service. |
| `ops/systemd/boonetools-wasm-arb-economics.timer` | Added the five-minute production timer. |
| `scripts/deploy-boonetools-backend-remote.sh` | Added the units to backend deployment. |
| `knowledge/wasm-arb-economics.md` | Documented metrics, attribution, comparison, and production components. |
| `knowledge/fee-collector-accounting.md` | Documented Wasm-linked collector accounting. |
| `knowledge/README.md` | Indexed the feature documentation. |

## In Progress

Implementation is complete and locally green. Production migration, service/timer activation, initial backfill, and live data-quality verification remain pending after review and merge.

## Next Steps

- [ ] Review and merge the `wasm-arb-economics` branch.
- [ ] Deploy migration 031 and the backend/API changes.
- [ ] Enable and verify the Wasm economics systemd timer.
- [ ] Confirm initial backfill coverage, historical prices, and read-model freshness in production.
- [ ] Validate the dashboard's equal-window verdict against live chain data and monitor provider/backfill health.
