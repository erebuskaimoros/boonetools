# Session Log Index

## Current Work In Progress

- Time-series renderer migration: shared controls are deployed; nine Chart.js integrations and native event views remain supported pending later migration

- App Layer fee-share settlement: monitor POL scheduler/backfill freshness, pricing, and separated Reserve/POL totals
- App Layer generated-fee ingestion: monitor source freshness, the forward watermark, provider quota, and lane 03 reconciliation
- Wasm Arb Economics: monitor the remaining oracle source gap and history compaction
- Thorfolio (`feat/thorfolio`, pushed, no PR): real-wallet signing tests for bond/LP/TCY actions and the coffee send; merge `origin/main` (`0fdfef2`) before opening a PR
- Footer swap panel: needs the STO/ThorKit affiliate key in `VITE_STO_WIDGET_API_KEY` at build time; a native ThorKit swap form on the shared wallet is under consideration
- Limit Orders tool: needs live wallet testing on the new per-chain routing model, plus final market/limit UX validation
- Finalize boonetools logo SVG and submit to THORChain Ecosystem page
- Monitor BooneTools read-model freshness, Burn Tracker daily/live reconciliation, THORNode core/cooldown health, provider-call volume, Dune quota, Bond History queue depth, and provenance conflicts
- TradingView Advanced Charts form: needs personal details to complete submission

## Recent Sessions

| Date | Focus | Summary | Link |
|------|-------|---------|------|
| 2026-10-21 #4 | Thorfolio design, route, footer swap and coffee panels | Design pass, multi-address bond history, `/thorfolio`, STO swap panel and RUNE tip panel on `feat/thorfolio`; 713 tests and checks pass, wallet signing untested | [Session](2026-10-21/session-4.md) |
| 2026-10-21 #3 | Thorfolio TCY APR and payouts | Corrected upstream APR inflation, added lifetime payout totals and fitted cumulative axes; 75 tests pass and two papercuts resolved | [Session](2026-10-21/session-3.md) |
| 2026-10-21 #2 | Thorfolio wrap-up | Resolved session-record staging friction, verified Svelte checks, and recorded the bounded papercut review; 79 entries remain open | [Session](2026-10-21/session-2.md) |
| 2026-10-21 #1 | Thorfolio bonds and wallet holdings | Restored Bond Tracker controls, added gated 3.21 payout management and held RUNE totals; 65 tests, static checks and build passed | [Session](2026-10-21/session-1.md) |
| 2026-09-26 #1 | Independent L1 vault balances | Prepared 12-chain custody comparisons, explicit gaps and shared-router backing checks for authorized publication | [Session](2026-09-26/session-1.md) |
