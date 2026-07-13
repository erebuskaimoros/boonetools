# Session 2 - Base Layer Earnings Accrual

> Date: 2026-07-13
> Focus: Correct App Layer lane 01 accounting so it records app-layer earnings allocated to the Base Layer for each day or week, then deploy the refreshed dashboard.

## Summary

Redefined dashboard lane 01 around the economic boundary the chart is meant to measure: newly earned app-layer value allocated to the Base Layer, rather than receipts observed only at the Base Layer collector. Daily and weekly rows now measure changes in routable inventory weighted by its configured Base Layer share (50% of RUJI Trade, 50% of Other Core Apps, and 100% of the Base Layer collector). Internal collector transfers, conversions, and Reserve payouts cancel rather than create earnings. Cumulative remains an optional rollup of the period rows and is not additive with lane 02. Regenerated the static artifacts through July 13, verified 98 tests and the production build, pushed `416cb89`, and deployed the frontend to boone.tools.

## Work Done

- Traced the misleading July 11 bar to collector-only accounting that showed the RUNE receipt while hiding the offsetting conversion leg.
- Reworked the inflow generator around a weighted routable-balance boundary:
  - RUJI Trade: 50% allocated to the Base Layer
  - Other Core Apps: 50% allocated to the Base Layer
  - Base Layer collector: 100% allocated to the Base Layer
  - RUJI Swap and RUJI Index: excluded because their configured routes do not target the Base Layer
- Made daily and weekly accrual the primary 01 metric; retained cumulative as an optional view.
- Treated final Reserve payouts as conservation movements: the collector balance reduction and payout add-back cancel, so lane 01 does not double-count lane 02.
- Updated dashboard headings, explanatory copy, summaries, pending-state labels, and tooltip ordering. Tooltips now expose signed conversion legs and any residual value.
- Regenerated checked-in JSON and CSV artifacts through 2026-07-13.
- Added regression coverage for route weights, internal-transfer cancellation, Reserve payout cancellation, signed denom flows, and cumulative reconciliation.
- Updated the local accounting note and shared BooneTools analytics wiki with the durable metric definition.
- Passed 98 tests, artifact validation, `git diff --check`, production build, and the workspace audit (0 errors, 0 warnings).
- Committed and pushed `416cb89 fix: measure app-layer earnings for base layer` to `main`.
- Deployed with `npm run boonetools:deploy:frontend` and verified the live route loads the corrected 01 heading, explanatory model, and `$31,194.81` cumulative app-layer earnings total.

## Discoveries

- Lane 01 is an earnings-accrual metric, not a Base Layer collector receipt metric. The collector is only the last on-chain waypoint before the Reserve.
- Reserve payouts belong in lane 02. In lane 01 they are only an accounting add-back that neutralizes inventory leaving the measured boundary; they do not create new earnings.
- Cumulative 01 remains useful for reconciliation, but it overlaps realized lane 02 and therefore must not be added to Total Benefit to THORChain.
- Current route configuration is applied across the full artifact window. Historical reconstruction will be needed if collector weights or eligible denoms changed materially during that window.

## Files Changed

| File | Change |
|------|--------|
| `scripts/rujira-base-layer-inflows.mjs` | Replaced collector-receipt accounting with weighted app-layer accrual accounting |
| `src/lib/AppLayerBaseLayerDashboard.svelte` | Updated 01 presentation, copy, pending state, and signed-flow tooltip behavior |
| `tests/rujira-base-layer-inflows.test.js` | Added accounting-boundary and reconciliation regressions |
| `docs/rujira-base-layer-fees/*` | Updated methodology and regenerated public reference artifacts |
| `public/data/rujira-base-layer-fees/*` | Regenerated production JSON and CSV artifacts |
| `knowledge/fee-collector-accounting.md` | Recorded the durable accounting model and caveats |
| `knowledge/sessions/2026-07-13/session-2.md` | This session log |
| `knowledge/sessions/_index.md` | Session index and current-work state updated |

## In Progress

None. The accounting correction is committed, pushed, deployed, and verified in production.

## Next Steps

- [ ] Monitor daily and weekly 01 rows after future revenue-route configuration changes.
- [ ] Reconstruct historical route configuration if weights or eligible denoms change within the retained artifact window.
- [ ] Consider moving the static artifact refresh into the production data pipeline so 01 stays current without a manual regeneration.
