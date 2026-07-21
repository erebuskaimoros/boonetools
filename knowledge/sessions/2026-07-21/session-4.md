# Session 4 - Block Chart Zoom and Five-Minute Backfill

> Date: 2026-07-21
> Focus: Add range zooming and reconstruct today's elevated block-time interval at five-minute resolution

## Summary

Added drag-to-highlight zooming to the status block-production chart and
deployed it with the existing accessible point tooltips. Reconstructed today's
10:05 AM–1:59 PM ET slowdown from 1,220 canonical THORChain headers into 47
five-minute buckets, replacing the overlapping hourly samples and publishing
the detailed curve to production.

## Work Done

- Added visible drag selection, sample-snapped range zooming, repeated narrowing, zoomed-window metrics, and a terminal reset control.
- Preserved point hover, click/touch, focus, and keyboard tooltip behavior above the zoom interaction layer.
- Added a reusable transactional block-production backfill command with bounded 20-block RPC paging and incomplete-range rejection.
- Added parsing, bucketing, paging, replacement, and integration coverage for the backfill path.
- Replaced three overlapping hourly bootstrap samples with 47 non-overlapping five-minute samples for heights 27,100,079–27,101,298.
- Deployed backend and frontend releases, republished the compact status model, and verified the live 14.7-second peak and dense slowdown curve.

## Discoveries

- The Tendermint `/blockchain` endpoint should be treated as a 20-header page; reconstructing a continuous range requires explicit bounded paging and a completeness check.
- Coarse samples must be removed when a finer series covers the same heights, or the chart's observed-block and weighted-average metrics double-count overlapping work.
- The detailed headers show a sustained roughly 13–14 second regime rather than a single isolated spike, followed by a sharp return toward six seconds around 1:30 PM ET.
- Keeping the transparent zoom capture below point hit targets lets range selection and accessible tooltips coexist without a second chart library.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/status/BlockProductionChart.svelte` | Added drag-highlight zooming, zoomed metrics, guidance, and reset behavior |
| `backend/src/shared/block-production.js` | Added canonical header paging, five-minute bucketing, completeness checks, and overlap replacement |
| `backend/src/backfill-block-production.js` | Added the transactional height-range backfill command |
| `backend/tests/block-production.test.js` | Covered parsing, bucketing, paging, and hourly-sample replacement |
| `knowledge/status-dashboard.md` | Documented the operational backfill workflow and safety behavior |

## In Progress

None - session complete and deployed.

## Next Steps

- [ ] Monitor the detailed slowdown points until they leave the rolling 24-hour public window and 48-hour database retention window.
- [ ] Reuse the range-selection interaction for future dense BooneTools time-series charts.
- [ ] Consider a timestamp-driven operator wrapper if historical block-time backfills become a recurring operational need.
