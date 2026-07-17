# Session 4 - TC Fee Chart Synchronized Zoom

> Date: 2026-07-16
> Focus: Give the TC Fee Dash income-to-volume chart the same zoom interaction as the primary chart

## Summary

Extended the TC Fee Dash's drag-to-select zoom behavior to the new liquidity-fee income / THORChain swap-volume chart. Either chart now controls the same date window, keeping both charts and the range navigator synchronized, while double-clicking either chart resets the full range.

## Work Done

- Generalized the existing chart-brush logic so it can target either Chart.js instance and canvas shell.
- Added drag selection, a scoped selection overlay, crosshair affordance, and double-click reset to the income-to-volume chart.
- Updated the range hint to make the shared interaction discoverable.
- Removed active window-level brush listeners during component teardown.
- Verified all 106 frontend tests, the production build, `git diff --check`, and the workspace audit.

## Discoveries

- Both fee charts render from the same selected `displayRows`, so one shared raw-row window is the correct source of truth for synchronized zoom.
- Brush coordinates must be translated from the selected chart shell into that chart canvas before using its x-scale pixel mapping.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/TCFeeDash.svelte` | Shared the zoom brush across both charts and added lower-chart interaction styling |
| `knowledge/sessions/2026-07-16/session-4.md` | Recorded the synchronized zoom follow-up |
| `knowledge/sessions/_index.md` | Added this session to the recent-session index |

## In Progress

Production frontend deployment is queued immediately after this session commit and push.

## Next Steps

- [ ] Deploy the pushed frontend with the canonical guarded deployment script.
- [ ] Verify the production TC Fee Dash loads the new frontend bundle.
- [ ] Confirm drag-to-zoom and double-click reset work from the lower chart in production.
