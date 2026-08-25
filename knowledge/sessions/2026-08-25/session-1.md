# Session 1 - Burn Chart Unit Toggle

> Date: 2026-08-25
> Focus: Add historical USD and RUNE display modes to the Burn Tracker chart

## Summary

The Burn Tracker chart now switches between `$` and `ᚱ` units while retaining RUNE as the default. Dollar-mode daily values use each UTC day's historical RUNE/USD price, and its cumulative series sums those historical daily values from the full ledger before the selected date preset is applied.

## Papercuts

- Resolved: None.
- Deferred: `pc-20260825-180507-3a8d5c` requires browser-runtime provisioning outside this repository; the other 31 open entries are pre-existing environment, provider, workflow, or larger deployment improvements outside this focused frontend release.
- Remaining open: 32.

## Work Done

- Added an accessible `$` / `ᚱ` segmented control to the Burn Tracker chart toolbar.
- Kept RUNE as the default unit and made the axis titles, tick labels, tooltips, chart description, and legend footer follow the selected unit.
- Derived daily historical USD burn and an all-time-anchored cumulative USD series from data already returned by the Burn Tracker API.
- Preserved honest gaps: a nonzero burn without price coverage is unavailable and prevents a later cumulative USD value from implying complete history.
- Added regression coverage for control wiring, chart field selection, cumulative USD accounting, zero-burn days, and missing-price behavior.
- Passed 222 frontend tests, the frontend surface/boundary/Svelte checks, a production build, whitespace validation, and the workspace audit.

## Discoveries

- The existing Burn Tracker read model already carries the historical daily RUNE/USD price, so the unit toggle requires no backend, migration, or provider changes.
- Cumulative USD must be calculated across the complete normalized ledger before applying 30/90/180-day ranges; calculating within a selected window would silently reset the cumulative baseline.
- A zero-RUNE burn has a determinate zero-dollar value even when price is missing, while a positive burn without price data must remain unavailable.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/BurnTracker.svelte` | Adds the accessible symbol toggle and unit-aware chart copy |
| `src/lib/burn-tracker/charts.js` | Switches series, axes, ticks, and tooltips between USD and RUNE |
| `src/lib/burn-tracker/model.js` | Derives daily and cumulative historical USD burn values |
| `tests/burn-tracker.test.js` | Covers unit controls, chart wiring, USD accumulation, and missing prices |
| `knowledge/sessions/2026-08-25/session-1.md` | Records the implementation and release handoff |
| `knowledge/sessions/_index.md` | Adds this session to the recent execution trail |

## In Progress

None - implementation and verification are complete; the canonical frontend deploy follows this session commit.

## Next Steps

- [ ] Confirm the live `$` control changes both burn axes and tooltips after deployment.
- [ ] Confirm `ᚱ` remains selected after a fresh page load.
- [ ] Monitor historical price coverage so cumulative USD stays complete.
