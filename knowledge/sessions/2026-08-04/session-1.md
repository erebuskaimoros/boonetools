# Session 1 - Dedicated Provider Ingestion and Wasm Arb Controls

> Date: 2026-08-04
> Focus: Make App Layer ingestion resilient on a dedicated Liquify endpoint and turn the hidden Wasm arb dashboard into a durable interactive time series.

## Summary

BooneTools now isolates its authenticated Liquify RPC route from public-gateway cooldowns, batches historical RPC work, and advances recent Rujira fee ingestion through a durable forward cursor without letting unrelated historical failures block the live lane. The hidden Wasm arb dashboard now supports synchronized drag zoom, 1-week and 1-month ranges, honest 1-hour/1-day/1-week aggregation, and compact controls above every chart; the corrected frontend and backend paths were deployed and verified in production.

## Work Done

- Provisioned a dedicated Liquify Portal THORChain RPC endpoint in the server-owned environment while keeping API credentials out of source control.
- Gave authenticated Liquify `/api=...` routes a redacted, independent provider-circuit-breaker scope so public gateway rate limits do not disable the dedicated endpoint.
- Reworked Rujira fee action discovery around Midgard forward paging with a durable watermark, bounded lookback, persisted progress, and a retry cooldown for unrelated historical failures.
- Added JSON-RPC `block_results` batching with configurable batch size, per-height response validation, per-height error persistence, and provider authentication headers.
- Added reconciliation of completed Base Layer earnings days when late Reserve payment events arrive.
- Added tests for dedicated cooldown scoping, forward catch-up, batch parsing/failures, provider retries, and completed-day reconciliation.
- Redesigned the hidden Wasm arb charts around a shared dynamic window with drag/pinch zoom, reset behavior, and `1h`, `1d`, and `1w` aggregation choices.
- Added explicit `1w`, `1mo`, `24h`, and all-history range presets and recalculated visible KPIs/totals whenever the shared range changes.
- Preserved compacted daily source rows at their native grain instead of misrepresenting daily totals as hourly observations; aligned weekly chart buckets to Monday UTC.
- Extracted responsive per-chart controls and placed them immediately above all five charts while keeping their state synchronized.
- Verified desktop and narrow layouts, synchronized control state, accounting invariants, production bundles, and hidden-route availability.

## Discoveries

- A dedicated Liquify endpoint shares `gateway.liquify.com` with public routes, so hostname-only cooldown keys can accidentally couple independent quotas; the authenticated path needs a redacted scope that never persists the API key.
- A websocket writer can advance the database maximum height past an outage gap. Recent Midgard recovery therefore needs its own durable forward watermark rather than deriving progress from the newest stored event.
- Head recovery and historical backfill are separate reliability lanes. Persisting head progress before historical work and pausing history when the head is incomplete prevents slow old pages from starving current data.
- JSON-RPC batches reduce provider calls substantially, but partial batch responses must be reconciled by request ID so one missing height does not discard successful neighbors.
- A requested chart grain may be finer than retained source history. The chart model must retain coarser source buckets honestly instead of inventing finer observations.
- Shared zoom state keeps chart ranges, headline KPIs, regime markers, and visible-range totals economically consistent even when controls are repeated above each chart.

## Files Changed

| File | Change |
|------|--------|
| `backend/.env.example` | Documented forward-lookback and RPC batch-size settings. |
| `backend/src/lib/config.js` | Added configuration for the new ingestion controls. |
| `backend/src/shared/provider-cooldown.js` | Added redacted dedicated Liquify cooldown scoping. |
| `backend/migrations/041_dedicated_provider_cooldown_scope.sql` | Documented the persisted circuit-breaker key contract. |
| `backend/src/shared/rujira-base-fees.js` | Added forward head catch-up, historical retry isolation, authenticated RPC batching, and expanded payload health state. |
| `backend/src/shared/rujira-base-layer-earnings.js` | Reconciled completed days against late Reserve payment events. |
| `backend/tests/provider-cooldown.test.js` | Covered dedicated and public breaker isolation. |
| `backend/tests/rujira-base-fees.test.js` | Covered forward pagination, persisted watermarks, batch responses, and failure handling. |
| `backend/tests/rujira-base-layer-earnings.test.js` | Covered completed-day payment reconciliation. |
| `docs/boonetools-backend-hetzner.md` | Documented safe server-only Liquify endpoint configuration. |
| `knowledge/architecture-consolidation.md` | Recorded the dedicated provider-breaker architecture. |
| `shared/wasm-arb-economics/model.js` | Added honest multi-grain chart aggregation and Monday-aligned weekly buckets. |
| `src/lib/WasmArbEconomics.svelte` | Added shared dynamic range/bucket state and per-chart control placement. |
| `src/lib/wasm-arb-economics/ChartControls.svelte` | Added the reusable responsive chart control bar. |
| `src/lib/wasm-arb-economics/charts.js` | Added Chart.js drag/pinch zoom and native-grain labels/tooltips. |
| `tests/wasm-arb-economics.test.js` | Covered additive accounting, value-density recomputation, weekly alignment, and coarse-source preservation. |

## In Progress

None - implementation and deployment are complete. Operational monitoring remains appropriate for Liquify quota usage, forward catch-up freshness, Base Layer reconciliation, and the known Wasm oracle source gap.

## Next Steps

- [ ] Monitor the Rujira forward watermark and ensure recent fee ingestion remains current through listener restarts.
- [ ] Track dedicated Liquify request volume, failures, and cooldown state against the Portal quota.
- [ ] Confirm completed-day Base Layer reconciliation remains zero-delta during normal operation and captures genuinely late payments.
- [ ] Watch the hidden Wasm dashboard as history crosses the hourly-retention boundary and verify mixed-grain labeling remains clear.
- [ ] Resolve or explicitly annotate the remaining pool/oracle source gap when upstream data becomes available.
