# Session 2 - Separate POL Analytics Presentation

> Date: 2026-08-18
> Focus: Separate THORChain POL capital from realized value-to-TC analytics

## Summary

The App Layer dashboard now presents TC Reserve settlement and THORChain POL capital as distinct analytical lanes. The top flow and headline totals make the accounting boundary explicit: realized value to TC is Reserve plus System Income, while POL capital is reported separately without inventing a split inside destination-neutral accrued earnings.

## Papercuts

- Resolved: None.
- Deferred: `pc-20260814-191717-e31dc4` and `pc-20260804-204153-4600b2` need separately designed deploy-workflow changes; `pc-20260818-170744-ba4bbd` needs a small update to the end-session skill outside this repository; the Windows/WSL, provider, migration-harness, transaction-decoder, and Codex execution/UI entries are unrelated to this frontend presentation change or require external/larger work.
- Remaining open: 17.

## Work Done

- Added a tested top-level value summary that excludes POL from realized value to TC while retaining an all-tracked-output total.
- Kept lane 01 destination-neutral and labeled it as pre-settlement rather than applying a speculative historical Reserve/POL split.
- Changed the Reserve settlement chart and table to Reserve-only values.
- Added a dedicated amber POL chart, controls, totals, price coverage, and weekly breakdown table.
- Split the top flow diagram, headline summary, and metric cards into distinct Reserve and POL destinations.
- Corrected content-pane sizing and grid minimum widths so the expanded visualization fits desktop and mobile without horizontal page overflow.
- Verified model tests, the complete frontend suite, Svelte diagnostics, a production build, and desktop/mobile browser layouts.

## Discoveries

- POL is protocol-owned liquidity capital and should not be silently added to the dashboard's realized-value-to-TC headline.
- Lane 01 is measured before the destination split, so it remains valid as a combined accrual boundary even when realized settlement is charted by destination.
- Dashboard components must size against the app content pane rather than `100vw` because the desktop navigation occupies part of the viewport.
- Grid children containing responsive canvases or wide scrollable tables need `min-width: 0` to prevent page-level mobile overflow.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/AppLayerBaseLayerDashboard.svelte` | Separates Reserve/POL charts and top visualization, updates accounting copy, and fixes responsive sizing |
| `src/lib/app-layer/model.js` | Adds the canonical separated value summary |
| `tests/app-layer-model.test.js` | Covers realized TC value, POL capital, and total tracked output accounting |
| `knowledge/sessions/2026-08-18/session-2.md` | Records the implementation and release handoff |
| `knowledge/sessions/_index.md` | Adds this session and updates active App Layer monitoring |

## In Progress

None - implementation and local verification are complete; production deployment will use this session's commit after the required CI verification.

## Next Steps

- [ ] Verify the live dashboard serves the separated Reserve and POL charts after deployment.
- [ ] Monitor POL scheduler/backfill freshness and Reserve/POL destination totals.
- [ ] Confirm the live headline continues to exclude POL from realized value to TC.
- [ ] Watch desktop and mobile chart layouts as the historical POL series grows.
