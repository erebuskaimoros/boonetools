# Session 1 - ADR26 Live Epoch Semantics

> Date: 2026-07-07
> Focus: ADR26 Dynamic Fees dashboard live epoch display and sealed/live accounting

## Summary

Updated and deployed the BooneTools website ADR26 Dynamic Fees dashboard so live accumulators are displayed as the epoch they will seal into instead of being merged with same-numbered sealed history. This fixes the confusing `E1868`/`E1868 live` split by normalizing current endpoint epochs to `reported epoch + 1` and keeps pair and affiliate fee accounting from hiding sealed rows.

## Work Done

- Confirmed Thornode's `/thorchain/dynamic_l1_fees_current` reports in-progress accumulators with the floor epoch even though those accumulators seal as the following epoch.
- Removed the dashboard's sealed/live merge behavior for pair charts, affiliate charts, and affiliate rollups.
- Added `liveSealEpoch` model semantics and UI labels so current rows display as `TC E{reported} + 1`.
- Updated model tests to assert sealed and live rows remain distinct, including same-numbered endpoint labels.
- Updated shared THORChain wiki notes with the corrected ADR26 current endpoint interpretation.
- Deployed the frontend to production with the guarded `npm run boonetools:deploy:frontend` script and verified the public ADR26 route plus deployed dynamic dashboard chunk.

## Discoveries

- The prior dashboard merge was a workaround for Thornode's current-endpoint epoch label, not a desired accounting behavior.
- Live ADR26 rows should be interpreted as in-progress state for the next seal epoch; sealed history rows and live accumulators must stay separate to avoid obscuring activity.
- Pair and affiliate totals should include both sealed history and live state once the live state is display-adjusted to the seal epoch.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/dynamic-fees/model.js` | Added live seal epoch normalization and removed sealed/live history de-duping. |
| `src/lib/DynamicFeeDashboard.svelte` | Displayed live current rows as `reported epoch + 1`, relabeled live epoch surfaces, and removed the affiliate dedupe column. |
| `tests/dynamic-fees-model.test.js` | Updated ADR26 model coverage for distinct sealed/live rows and adjusted live epoch semantics. |
| `../../knowledge/workstreams/analytics-and-tooling.md` | Recorded the ADR26 current endpoint live epoch display rule in the shared wiki. |
| `../../knowledge/projects/boonetools.md` | Added BooneTools operational guidance for ADR26 live accumulator epoch labels in the shared wiki. |
| `../../knowledge/log.md` | Added a dated shared-wiki log entry for the ADR26 live epoch interpretation update. |

## In Progress

None - session complete.

## Next Steps

- [ ] Re-check the `ETH.USDC / THOR.RUNE` pair after the next epoch boundary to confirm sealed `E1869` appears as expected.
- [ ] Watch affiliate rollups for any remaining volume/fee mismatches now that sealed/live rows are no longer merged.
