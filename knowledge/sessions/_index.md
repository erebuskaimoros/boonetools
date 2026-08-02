# Session Log Index

## Current Work In Progress

- App Layer generated-fee ingestion: lane 03 is stalled after the Liquify WebSocket stopped delivering blocks; deploy the endpoint cleanup, add an independent live-head scanner, catch up from block 27,235,929, and surface source freshness
- Wasm Arb Economics: corrected v2 accounting is locally green on `wasm-arb-economics`; needs review/merge, migration 032 deployment, corrected backfill, and live reconciliation
- Limit Orders tool: needs live wallet testing on the new per-chain routing model, plus final market/limit UX validation
- Finalize boonetools logo SVG and submit to THORChain Ecosystem page
- Monitor BooneTools read-model freshness, THORNode core/cooldown health, provider-call volume, Dune quota, Bond History queue depth, and provenance conflicts
- TradingView Advanced Charts form: needs personal details to complete submission

## Recent Sessions

| Date | Focus | Summary | Link |
|------|-------|---------|------|
| 2026-08-02 #1 | App Layer Fee Diagnosis and Endpoint Deprecation | Isolated the generated-fee ingestion outage and removed deprecated provider hosts throughout BooneTools | `sessions/2026-08-02/session-1.md` |
| 2026-08-01 #1 | Social Cards and Pool Source Preference | Added social link previews and stable pool reference preference, then deployed the verified frontend | `sessions/2026-08-01/session-1.md` |
| 2026-07-30 #2 | Site-wide Readability Pass | Raised typography and contrast across every route, chart, briefing, and mobile layout, then deployed the verified release | `sessions/2026-07-30/session-2.md` |
| 2026-07-30 #1 | Pool Dislocation Reliability and Rolling Averages | Added selectable rolling averages, self-healing sampling, and exact historical repair | `sessions/2026-07-30/session-1.md` |
| 2026-07-29 #3 | Pool Dislocation Dashboard | Added exact five-minute pool/Oracle/Binance dislocation with halt-aware filtering and durable APIs | `sessions/2026-07-29/session-3.md` |
