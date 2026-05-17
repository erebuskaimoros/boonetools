# Session 1 - Bond Tracker APY Prolonged Churn Fix

> Date: 2026-04-24
> Focus: Fix Bond Tracker APY when churn is delayed past the nominal interval

## Summary

Investigated why the Bond Tracker APY card looked too high during a delayed churn window. The issue was frontend annualization logic that capped churn progress at 100%, so accrued `current_award` was still divided by the nominal churn interval instead of the longer actual elapsed block window.

## Work Done

- Reproduced the APY calculation from live THORNode/Midgard data for the affected bond address.
- Confirmed the chain was in a prolonged churn window, with current height already past the expected next churn height.
- Updated the APY helper so progress can exceed 100% and prolonged churns annualize over actual elapsed blocks.
- Updated Bond Tracker input generation to pass uncapped `progressedBlocks`.
- Added a regression test for prolonged-churn APY behavior.
- Ran the APY test, full frontend test suite, production build, pushed `main`, and deployed the frontend to `boone.tools`.

## Discoveries

- The correct model is prolonged churn, not stale churn data: when churn cannot execute on time, `current_award` keeps accruing and APY must use the longer elapsed block period.
- The early-churn progress floor is still useful before the expected churn boundary, but after the boundary the APY estimate should stop projecting to a nominal interval.
- For the checked live values, the old nominal-interval estimate was about 494% APY while the prolonged-churn estimate was about 130% APY.
- The deploy script still reports unrelated local files, but the committed frontend change deployed cleanly from `main@af76bc9`.

## Files Changed

| File | Change |
|------|--------|
| website/src/lib/bond-tracker/apy.js | Added prolonged-churn APY behavior using actual elapsed block time |
| website/src/lib/BondTrackerV2.svelte | Passed uncapped churn progress into the APY estimator |
| website/tests/bond-tracker-apy.test.js | Added regression coverage for prolonged churn |
| ../knowledge/projects/boonetools.md | Added durable operational note for prolonged-churn APY semantics |
| ../knowledge/log.md | Logged the Bond Tracker APY fix |

## In Progress

None - session complete. Unrelated website edits remain intentionally unstaged in `docs/style.md`, `package.json`, and `DESIGN.md`.

## Next Steps

- [ ] Monitor the live Bond Tracker APY card during the current delayed churn window.
- [ ] Recheck APY immediately after the next successful churn to confirm it returns to normal early-churn floor behavior.
- [ ] Consider exposing a small "prolonged churn" hint in the APY card if users keep asking why current APY differs from completed-churn history.
- [ ] Clean up the pre-existing Svelte build warnings separately.
