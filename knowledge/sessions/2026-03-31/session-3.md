# Session 3 - Bond Tracker Block-Aware APY Refinement + Frontend Deploy

> Date: 2026-03-31
> Focus: Make Bond Tracker APY estimation more precise using churn block progress and deploy the frontend

## Summary

Refined the Bond Tracker APY card again after the prior churn-smoothing change proved too conservative. The new estimate uses actual churn block progress from `getChurnState()` plus a small minimum progress floor, which makes the APY card more responsive without letting the first few blocks spike the number unrealistically.

## Work Done

- Replaced the full-interval clamp approach with a block-aware APY estimate based on `progressedBlocks`, `totalBlocks`, and `secondsPerBlock`
- Switched Bond Tracker from `getLastChurn()`/`getChurnInfo()` to `getChurnState()` so the card can use live churn height progress and next-churn timing from one source
- Added a helper that projects current reward through the churn using block progress and applies a minimum `5%` progress floor for the earliest blocks
- Updated both single-node and multi-node APY card paths to use the block-aware estimator
- Reworked the APY regression tests to cover block-projected reward, minimum progress flooring, and fallback behavior when block progress metadata is unavailable
- Verified with `npm test` and `npm run build`, then rebuilt with `/boonetools/` base and deployed the static site to Hetzner

## Discoveries

- Using churn blocks gives a better APY estimate than either raw elapsed seconds or a full-interval clamp because it tracks actual churn progress instead of time alone
- A small floor on progress is still necessary; otherwise the first one or two churn blocks can produce projections that are too jumpy
- `getChurnState()` is the better source for the APY card because it bundles last churn, next churn, current height, and block timing in one fetch

## Files Changed

| File | Change |
|------|--------|
| src/lib/BondTrackerV2.svelte | Switched APY card calculations to block-aware churn state inputs for single-node and multi-node views |
| src/lib/bond-tracker/apy.js | Added block-progress-based yield projection and a minimum progress floor |
| tests/bond-tracker-apy.test.js | Replaced the old smoothing regression tests with block-aware projection and floor coverage |

## In Progress

Rapid Swaps listener/recorder edits in `scripts/rapid-swap-listener.mjs` and `supabase/functions/_shared/rapid-swaps.ts` remain locally modified and were intentionally excluded from this session commit and deploy.

## Next Steps

- [ ] Watch the live Bond Tracker APY card at the start and middle of the next churn to confirm the new estimate stays stable and believable
- [ ] Tune the minimum progress floor if the early-interval estimate still feels slightly high or low in live usage
- [ ] Consider exposing the APY estimate basis in the UI so users understand it is projected from current churn progress
- [ ] Review and commit the outstanding rapid-swap listener/recorder edits as a separate session if they are ready
