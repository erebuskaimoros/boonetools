# Session 1 - Live System Income POL Analytics

> Date: 2026-09-01
> Focus: Launch and refine live SIPOL tracking across POL Tracker and POL TVL

## Summary

Launched the new System Income POL dashboard at `/pol-tracker`, moved the legacy POL dashboard to `/pol-tvl`, and integrated SIPOL into the existing POL valuation history. The new backend follows finalized block events, reconciles live LP holdings, estimates ownership-weighted fees hourly from a seeded baseline, and feeds both dashboards through the current read-model and streaming paths. Multiple UX passes added the requested headlines, token and pool links, asset logos, daily-plus-cumulative charting, unit switching, tooltips, zoom/reset controls, live deployment feedback, and more readable secondary text before the final production deploy.

## Papercuts

- Resolved: None.
- Deferred: `pc-20260901-001953-98fa14`, `pc-20260831-233844-1c85ef`, `pc-20260831-213817-3c47ac`, `pc-20260831-212006-78eed3`, `pc-20260831-211647-d1fc13`, `pc-20260831-210104-50e1f7`, `pc-20260831-205707-734c03`, `pc-20260831-053637-5ec8fd`, `pc-20260831-050120-ceba63`, `pc-20260831-025338-5189ec`, `pc-20260830-232256-cbfaa1`, `pc-20260830-030941-325c82`, `pc-20260828-200600-5b89e8`, `pc-20260828-190310-8b9e03`, `pc-20260827-124929-705e15`, `pc-20260827-124430-4ed288`, `pc-20260826-172323-f37040`, `pc-20260826-163157-de1258`, `pc-20260826-160320-ffc634`, `pc-20260826-112633-d998e0`, `pc-20260825-203637-ef0a37`, `pc-20260825-203020-974843`, `pc-20260825-200434-92b104`, `pc-20260825-191747-84b22c`, `pc-20260825-183209-a5d18d`, `pc-20260825-180507-3a8d5c`, `pc-20260823-211925-3aa411`, `pc-20260823-211030-ab3ecc`, `pc-20260823-113805-9c49b0`, `pc-20260823-113228-bdd209`, `pc-20260821-183439-522f8e`, `pc-20260820-183859-7b8740`, `pc-20260820-173507-fe9da6`, `pc-20260819-195219-1e6066`, `pc-20260819-191052-c9c0be`, `pc-20260819-174457-9bbafe`, `pc-20260819-164130-4d6205`, `pc-20260819-163407-e13290`, `pc-20260819-150914-ede96b`, `pc-20260818-185343-806d7d`, `pc-20260818-170744-ba4bbd`, `pc-20260804-204153-4600b2`, `pc-20260814-191717-e31dc4`, `pc-20260813-184755-38d9c7`, `pc-20260813-184249-f2fceb`, `pc-20260813-035156-b7aee9`, `pc-20260812-025502-da4e9f`, `pc-20260810-220607-6ec7af`, `pc-20260805-214606-4a4952`, `pc-20260805-153306-2143b1`, `pc-20260805-151549-a8e8e1`, `pc-20260804-203213-82b5e5`, `pc-20260804-202939-bbdfc3`, `pc-20260804-173720-b6a917`, `pc-20260804-172554-22bc55`, `pc-20260804-165608-ffcf08`, and `pc-20260804-165534-017afe`. The newest frontend-test documentation item is not reproducible because `README.md` already documents `npm test`; the remaining entries require architectural/product work, external tooling or provider changes, or separate evidence and verification beyond a bounded end-session review.
- Remaining open: 57.

## Work Done

- Renamed the previous POL dashboard route to `/pol-tvl` while preserving it in navigation, then launched and later published `/pol-tracker` in the navigation.
- Added the System Income POL backend schema, block-event ingestion, gap repair, reconciliation, scheduler, read model, handler, and production service/timer wiring.
- Reworked the SIPOL dashboard around five headline cards, live LP holdings, current assets, per-pool positions, and finalized block-event history.
- Added daily deposit bars plus cumulative deposits, RUNE/USD switching, hover tooltips, range presets, drag-to-zoom, reset, token logos, THORChain explorer links, and transient per-block deposit feedback.
- Changed estimated fee accounting from daily to hourly, seeded its first usable value, and retained explicit coverage/provenance semantics.
- Integrated SIPOL value into POL TVL and corrected the valuation to count the full redeemable LP position rather than one leg.
- Added regression coverage across backend accounting, frontend models, navigation, chart behavior, and muted-text readability.
- Passed local tests, checks, builds, workspace audit, GitHub CI, and production smoke verification; deployed the backend and frontend releases.

## Discoveries

- SIPOL gross deployment can update from finalized block events while redeemable holdings and position value must still reconcile against current pool state.
- Full SIPOL USD value is the value of both redeemable LP legs; using only the RUNE leg materially understates POL TVL.
- The fee number is an ownership-weighted estimate of pool liquidity fees, not position P&L, so hourly coverage and source provenance must remain visible in the model even when the headline is concise.
- Production deploy guards require a clean canonical `main`, so unrelated concurrent files must be preserved outside the release state and restored afterward.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/054_system_income_pol.sql` through `057_system_income_pol_hourly_fees.sql` | Added SIPOL storage, headlines, POL TVL integration, and hourly fee estimation schema. |
| `backend/src/shared/system-income-pol*.js` | Added finalized block ingestion, repair, reconciliation, storage, and hourly accounting. |
| `backend/src/handlers/system-income-pol.js` and runtime wiring | Exposed the read model and registered its jobs, listener, server route, and service timers. |
| `backend/src/shared/pol-tracker*.js` and `backend/src/handlers/pol-tracker.js` | Added SIPOL to legacy POL history and corrected full current-position valuation. |
| `src/lib/SystemIncomePOL.svelte` | Built and iteratively refined the live SIPOL dashboard, charts, links, feedback, and readable muted text. |
| `src/lib/POLTracker.svelte`, `src/lib/pol-tracker/*`, and `shared/pol-tracker/model.js` | Added SIPOL history and current value to POL TVL. |
| `src/App.svelte` | Split the routes and published System Income POL in navigation. |
| `backend/tests/*pol*.test.js`, `tests/system-income-pol.test.js`, and related frontend tests | Added regression coverage for accounting, data flow, charts, navigation, and presentation. |
| `docs/*`, `knowledge/pol-tracker.md`, and `knowledge/system-income-pol.md` | Documented production architecture, semantics, and operations. |
| `scripts/*deploy*` and `ops/systemd/boonetools-system-income-pol.*` | Added guarded production deployment and scheduled operation. |

## In Progress

None - session complete.

## Next Steps

- [ ] Monitor hourly fee coverage and seed-to-observed transitions over the next production windows.
- [ ] Confirm POL TVL and SIPOL tracker remain reconciled as additional SIPOL pools or assets appear.
- [ ] Watch block-stream gap repair and position snapshot freshness under provider degradation.
- [ ] Revisit the deferred papercut backlog as separate, scoped maintenance work.
