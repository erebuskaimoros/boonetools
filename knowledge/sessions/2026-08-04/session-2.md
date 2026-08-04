# Session 2 - ADR26 Affiliate Revenue Rolling Averages

> Date: 2026-08-04
> Focus: Add independently toggleable revenue rolling averages to the ADR26 Affiliate Trend chart and deploy the verified frontend.

## Summary

The ADR26 Affiliate Trend chart now calculates and displays 30-day, 90-day, and 180-day rolling averages for affiliate fee revenue alongside the existing volume averages. Volume and revenue windows are independently toggleable, can be overlaid simultaneously, preserve the established halt-day and warm-up semantics, and are live on boone.tools.

## Work Done

- Extended the affiliate trend view model with rolling fee-revenue series for every configured window.
- Applied the same cached warm-up history and May/June 2026 halt-day exclusions to revenue and volume averages.
- Preserved the accounting boundary between current-priced display fees and historically priced fees used for the fees-per-volume rate.
- Replaced the single rolling-average metric switch with independent volume and revenue window controls so any combination can be displayed together.
- Assigned rolling revenue lines to the fee axis and added distinct line patterns, legend labels, tooltips, and active-chart metadata.
- Fixed the combined selection metadata layout at narrow viewport widths.
- Added model coverage for daily warm-up values, halt exclusions, and weekly bucket aggregation of fee averages.
- Ran the full frontend test, diagnostics, build, desktop, and mobile verification paths without new errors.
- Committed and pushed only the ADR26 files, waited for GitHub verification, and deployed through the guarded atomic frontend release flow.
- Confirmed the live ADR26 route serves the production bundle containing the new controls and rolling fee series.

## Discoveries

- Affiliate Trend revenue averages must use the visible fee series. The fees-per-volume line intentionally uses a separate historical RUNE/USD numerator and must not be reused for displayed revenue.
- Independent per-metric window state is clearer and more capable than a mutually exclusive metric selector; it supports mixed windows such as 30-day volume plus 90-day revenue.
- When corresponding volume and revenue windows share a color, line pattern and axis assignment provide the necessary secondary distinction.
- The combined chart metadata needs a stacked mobile header because simultaneous selections can exceed the width available beside the section title.
- A dirty production checkout can still produce a scoped, safe release by committing only owned files and deploying the CI-green commit from a clean checkout.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/dynamic-fees/model.js` | Added rolling fee-revenue calculations and bucketed rolling fee output. |
| `src/lib/DynamicFeeDashboard.svelte` | Added independent volume/revenue controls, simultaneous chart overlays, line styling, and responsive metadata layout. |
| `tests/dynamic-fees-model.test.js` | Covered fee-average warm-up, halt exclusion, and grouped-bucket behavior. |

## In Progress

None - session complete.

## Next Steps

- [ ] Monitor the live Affiliate Trend chart as new daily buckets arrive.
- [ ] Preserve the display-fee versus historical-rate distinction in future affiliate analytics changes.
- [ ] Consider persisting rolling-average selections if users regularly revisit the same overlays.
- [ ] Recheck multi-series readability if additional affiliate trend metrics are introduced.
