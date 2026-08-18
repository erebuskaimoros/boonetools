# Session 1 - Rujira Fee-Share Settlement Cutover

> Date: 2026-08-18
> Focus: Update and release the App Layer dashboard for Rujira's new fee-share targets

## Summary

BooneTools now models the 2026-08-13 Rujira target changes as typed Base Layer settlement rather than Reserve-only payments. The API preserves its legacy Reserve fields while adding POL and combined settlement totals, and the dashboard shows the new 2:1 branches without rewriting pre-cutover history.

## Papercuts

- Resolved: None.
- Deferred: `pc-20260814-191717-e31dc4` needs a separately designed clean-main deploy preservation helper; `pc-20260813-184755-38d9c7`, `pc-20260813-184249-f2fceb`, and `pc-20260805-214606-4a4952` concern external Windows/WSL SSH behavior; `pc-20260813-035156-b7aee9`, `pc-20260810-220607-6ec7af`, `pc-20260804-173720-b6a917`, `pc-20260804-172554-22bc55`, `pc-20260804-165608-ffcf08`, and `pc-20260804-165534-017afe` concern execution or UI tooling outside this feature; `pc-20260812-025502-da4e9f` needs a separate transaction-decoder setup; `pc-20260805-153306-2143b1` and `pc-20260805-151549-a8e8e1` depend on Liquify provider behavior; `pc-20260804-204153-4600b2` is a larger deploy-gate change; and `pc-20260804-203213-82b5e5` plus `pc-20260804-202939-bbdfc3` require a dedicated migration-test harness.
- Remaining open: 16.

## Work Done

- Added an exact regression for the first 2:1 Reserve/POL distribution at height `27410412` and a pre-cutover guard.
- Added typed `reserve` and `pol` canonical events while retaining the original Reserve identity and API fields.
- Kept the scheduled RPC settlement scan active after successful Dune Reserve ingestion.
- Added migration 044 to constrain settlement destinations, requeue affected blocks, and rewind the cadence cursor.
- Updated lane 01 conservation to add back both Base Layer settlement destinations.
- Updated live/fallback route maps, total benefit, lane 02 charts and tables, recent events, timeline, labels, and documentation.
- Verified 266 backend tests, 197 frontend tests, zero Svelte errors, the frontend surface/boundary checks, and a production build.

## Discoveries

- The contracts did not need a code migration for this change; the target weights changed at height `27410382`, with the first split payout at height `27410412`.
- Dune query `7620011` remains a direct Reserve source. POL settlement must come from scheduled block-result parsing, so a successful Dune run cannot short-circuit the RPC lane.
- Historical compatibility requires `payment_*` and `eventCount` to remain Reserve-only; additive `pol_*` and `settlement_*` fields carry the new accounting.
- Lane 01 conservation treats Reserve and POL outflows alike because both are settlement of value already accrued inside the weighted Base Layer boundary.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/044_rujira_fee_share_settlements.sql` | Adds typed settlement storage and post-cutover reparse state |
| `backend/src/shared/rujira-reserve-payments.js` | Parses, prices, stores, and aggregates Reserve/POL settlement |
| `backend/src/shared/rujira-base-layer-earnings.js` | Conserves both settlement destinations in lane 01 |
| `backend/src/handlers/app-layer-reserve-payments.js` | Uses settlement terminology in warming/stale responses |
| `backend/tests/*.test.js` | Covers the cutover, combined read model, Dune/RPC behavior, and reconciliation |
| `src/lib/AppLayerBaseLayerDashboard.svelte` | Renders new routes, combined totals, charts, tables, and events |
| `src/lib/app-layer/model.js` | Normalizes typed settlement while supporting legacy payloads |
| `src/lib/app-layer/charts.js` | Adds the POL chart series |
| `tests/app-layer-model.test.js` | Covers post-cutover and legacy fallback aggregation |
| `README.md`, `docs/`, `knowledge/fee-collector-accounting.md` | Documents the cutover and operational backfill contract |
| `scripts/rujira-base-layer-inflows.mjs` and inflow seed copies | Clarify combined settlement conservation and Reserve-only fallback scope |

## In Progress

None - implementation and local verification are complete; release verification is owned by the canonical deployment scripts after this commit.

## Next Steps

- [ ] Confirm migration 044 completes the post-cutover scheduled-block reparse.
- [ ] Verify the live dashboard shows Reserve, POL, and combined settlement totals.
- [ ] Monitor settlement pricing and scheduler freshness after deployment.
- [ ] Regenerate the dated static Reserve fallback if fresher outage coverage is required.
