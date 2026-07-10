# Session 1 - App Layer Revenue-Flow Integrity

> Date: 2026-07-10
> Focus: Correct Rujira App Layer -> Base Layer dashboard semantics and harden its historical ingestion lanes.

## Summary

Reworked the dashboard so it distinguishes live target-denom eligibility, configured conversion inventory, unconfigured inventory, and unavailable action state rather than treating target addresses or stale collector totals as revenue flow. Hardened both historical lanes with source validation, canonical deduplication, and truthful Dune/legacy/mixed provenance.

## Work Done

- Extended the live-state endpoint with every collector's balances and conversion actions; versioned its cache payload.
- Reworked the dashboard to show only explicit final `RESERVE` deposits as revenue and to keep generated THORChain liquidity fees non-additive.
- Added generated-fee canonicalization, Dune validation, source-precedence upserts, historic cleanup, and provenance reporting.
- Required Reserve Dune rows and RPC fallback rows to prove the explicit collector -> TC Reserve `RESERVE` RUNE payment path.
- Consolidated artifact generators under `website/scripts`, deprecated the old non-additive collector snapshot, and updated docs.

## Discoveries

- Revenue collector target addresses are weighted allocations for configured target denoms; they do not make every held denom transferable.
- Dune and RPC observations of the same swap use different source identifiers, so logical swap identity and retained source provenance are required to avoid double-counting.
- A Base Collector -> Reserve transfer is not sufficient evidence of a Reserve payment without a matching valid `reserve` event and `RESERVE` memo.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/AppLayerBaseLayerDashboard.svelte` | Corrected route, inventory, fallback, and provenance semantics. |
| `backend/src/shared/app-layer-live-state.js` | Added per-collector balance/action live-state payload. |
| `backend/src/shared/rujira-base-fees.js` | Added validated canonical generated-fee ingestion and source reporting. |
| `backend/src/shared/rujira-reserve-payments.js` | Enforced explicit Reserve-payment evidence. |
| `backend/migrations/021_rujira_base_fee_event_canonicalization.sql` | Canonicalized, cleaned, and deduplicated generated-fee rows. |
| `backend/migrations/022_rujira_reserve_payment_source_validation.sql` | Validated and cleaned Reserve-payment Dune rows. |
| `backend/tests/rujira-base-fees.test.js` | Added Dune-invariant, canonicalization, and provenance coverage. |
| `backend/tests/rujira-reserve-payments.test.js` | Added strict Reserve parser and Dune input coverage. |
| `scripts/rujira-*.mjs` | Consolidated corrected generators under the website repository. |
| `README.md`, `docs/rujira-base-layer-fees/README.md` | Corrected artifact scope and operator guidance. |

## In Progress

No code work remains. Migrations `021` and `022` still need the normal production deployment/migration run; no deployment was performed in this session.

## Next Steps

- [ ] Deploy the website backend and apply migrations `021` and `022` through the standard migration script.
- [ ] Verify production API metadata reports the persisted Dune, legacy, or mixed source state.
- [ ] Verify the live dashboard shows per-collector inventory and action-query degradation correctly.
- [ ] Regenerate static artifacts when a fresh fallback snapshot is desired.
