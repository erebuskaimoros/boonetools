# Session 2 - Wasm Arb Accounting Correction

> Date: 2026-07-29
> Focus: Corrected Wasm volume, Rujira fee, TC value-density, spread, and pool/oracle accounting

## Summary

Corrected the Wasm Arb Economics dashboard after the original analysis understated Rujira revenue and overstated Wasm volume. The v2 pipeline now reproduces the corrected 29h25m Mimir comparison, separates strict from broad attribution, tracks the later `spread_bps` intervention, and reports pool prices against same-height oracle prices without folding that non-cash evidence into the TC cash-flow verdict.

## Work Done

- Collapsed identical duplicate Midgard outbounds before executed-leg valuation and versioned corrected action identities.
- Replaced incomplete collector discovery with independent Tendermint `tx_search` and `block_search` lanes covering transaction and finalize-block fee transfers.
- Enumerated all configured FIN contracts, retained their market denoms, priced unsupported fee denoms through same-transaction FIN execution rates, and kept FIN range fees as a subset.
- Restricted strict FIN attribution to transaction-local Wasm execution while retaining direct Wasm AMM fees and a clearly labeled broad FIN+AMM context.
- Added strict and broad TC value per $1m of network and Wasm volume, network liquidity fees/yield, Wasm fee yield, and corrected break-even accounting.
- Recorded the verified `spread_bps=3` intervention and added selectable Mimir/spread comparisons.
- Added same-height pool/oracle sampling for 12 comparable Wasm-path pools, including depth-weighted, tail, within-band, signed, and LTC-excluded metrics.
- Added migration 032 and versioned action, fee, requested-scan, and completed-scan state so stale accounting cannot appear complete after a rollback.
- Updated the dashboard, backend/deployment documentation, accounting knowledge, and exact regression fixtures.
- Verified disposable-Postgres migration plus ingestion/read-model execution, 156 frontend tests, 186 backend tests, repository checks, production build, and desktop/mobile browser QA.

## Discoveries

- The Cosmos transaction REST pagination path repeated the first page because its offset was ignored; Tendermint transaction and block indexes are the reliable discovery boundary for this collector ledger.
- A FIN fee in `finalize_block_events` cannot be linked to a specific Wasm transaction merely because the same block contains Wasm activity. It belongs only in broad context unless transaction-local evidence exists; a direct transfer from the Wasm AMM remains attributable.
- FIN execution events can price received fee denoms that lack a direct historical pool price, but only when the execution rate and priced counter-denom occur in the same transaction context.
- Versioning desired block scans is insufficient by itself: completed scans need their own accounting version so an older binary cannot mark a corrected block complete.
- Version filters combined with dynamic archive predicates must group the entire `OR` expression, or archived version-1 fee rows can bypass the filter through SQL precedence.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/032_wasm_arb_economics_accounting.sql` | Added spread, FIN metadata, oracle samples, cache rebuild, and scan-version schema. |
| `backend/src/shared/wasm-arb-economics-ingestion.js` | Corrected action/fee discovery, pricing, linkage, oracle ingestion, and rollback-safe scan completion. |
| `backend/src/shared/wasm-arb-economics.js` | Added v2 aggregation, independent intervention archives, corrected completeness, and oracle payload fields. |
| `backend/src/shared/analytics-read-model-keys.js` | Advanced the dashboard read-model key to v2. |
| `backend/src/shared/analytics-read-models.js` | Published the v2 payload schema. |
| `backend/src/lib/config.js` | Added oracle backfill configuration. |
| `backend/.env.example` | Documented oracle ingestion settings. |
| `shared/wasm-arb-economics/model.js` | Added corrected unit economics and independent pool/oracle summaries. |
| `src/lib/WasmArbEconomics.svelte` | Added corrected ledger rows, intervention controls, oracle panel, and data-health states. |
| `backend/tests/wasm-arb-economics.test.js` | Added duplicate, FIN pricing/linkage, search-lane, and oracle tests. |
| `backend/tests/wasm-arb-economics-read-model.test.js` | Added intervention archive and version-filter regression coverage. |
| `tests/wasm-arb-economics.test.js` | Replaced the original fixture with exact corrected report numbers and oracle completeness tests. |
| `knowledge/wasm-arb-economics.md` | Documented the corrected accounting and production rebuild behavior. |
| `knowledge/fee-collector-accounting.md` | Documented full FIN/AMM discovery, pricing, and attribution boundaries. |
| `docs/boonetools-backend-hetzner.md` | Documented the v2 production lane, migration, and configuration. |

## In Progress

Implementation is complete and locally verified. Review/merge, production migration 032 deployment, corrected v2 backfill, and live reconciliation remain pending.

## Next Steps

- [ ] Review and merge the corrected `wasm-arb-economics` branch.
- [ ] Deploy migration 032 and the v2 backend/frontend release.
- [ ] Monitor action, transaction-search, block-search, fee-pricing, block-scan, and oracle backfill completeness.
- [ ] Reconcile the first complete production Mimir and spread windows against the corrected fixtures and published report.
- [ ] Monitor pool/oracle tails, especially the LTC-excluded comparison, before drawing non-cash conclusions.
