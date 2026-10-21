# Session 3 - Thorfolio TCY APR and cumulative payouts

> Date: 2026-10-21
> Focus: Correct TCY payout annualization and add a lifetime payout line with a fitted axis.

## Summary

Investigated the reported roughly 70% TCY APR and reproduced an upstream
annualization defect before fixing Thorfolio's calculation. Added a cumulative
payout line that retains all payouts before the selected date range, scopes to
the selected addresses, and fits its axis to the visible domain.

## Work Done

- Derive a fixed trailing 30-day payout APR from timestamps and current stake
  and prices, independently of Midgard's scalar and payout ordering. Missing
  data remains unavailable; measured zero remains zero.
- Label the APR basis and expose its limitations in the UI. Both example
  providers now show the same payout ratio, about 9.66% at browser verification.
- Add an amber lifetime-total line alongside daily payout bars, with RUNE and
  historical payout-value modes and separate scales. Date filters change the
  visible domain without resetting total paid out.
- Fit the cumulative scale to visible values with 5% padding. Keep the daily
  bars' zero baseline. Verified 30-day and 90-day views and both unit modes.
- Preserve the discovered Midgard behavior and chart contract in
  `knowledge/thorfolio-tcy-apr.md`; update the shared project wiki.

## Discoveries

Midgard groups TCY payouts without ordering, then can use the arbitrary first
event to shorten annualization while retaining all 30 days of rewards. For
provider …pqx8 that event was about 3.7 days old, inflating the rate roughly
eightfold. Thorfolio uses the complete 30-day denominator and current prices;
this is a payout ratio, not a time-weighted personal return.

## Verification

- 75 focused Position Tracker / Thorfolio tests pass, including the failing
  APR reproduction, missing-data UI, lifetime totals, address filtering, and
  historical value accumulation.
- `npm run check`: 0 errors and 56 existing warnings, within the baseline.
- `npm run build`: passed in 50.22 seconds; existing dependency-annotation and
  large-chunk warnings remain.
- Project ownership audit: 0 errors and 0 warnings; GitHub origin direct push
  is the authorized route for `boonetools-website`.
- `git diff --check` passes. Browser verification used the running server at
  `localhost:5174` in the `feat/thorfolio` worktree.

## Papercuts

- Resolved `pc-20261021-055716-578aea`: the SSR harness recursively compiles
  nested Svelte component imports; the panel-render test passes with SeriesLegend.
- Resolved `pc-20261021-060935-6f8547`: documented the verified reload step for
  local Chart.js option changes after hot reload, then verified range switching.
- Deferred `pc-20261021-024622-f608bf`: the earlier Svelte output-format issue
  remains unverified; the final check passes without a parser change.
- Remaining open: 79. Review was bounded to current-session friction; no wider
  backlog cleanup was performed.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/position-tracker/model.js` | Independent APR and lifetime payout series |
| `src/lib/position-tracker/TcyPanel.svelte` | APR basis, cumulative line, tooltip, legend, fitted scale |
| `tests/position-tracker.test.js` | Deterministic APR expectation |
| `tests/thorfolio-tcy-apr.test.js` | Annualization, missing-data and rendering regressions |
| `tests/thorfolio-tcy-cumulative.test.js` | Lifetime totals and range/address filtering coverage |
| `knowledge/thorfolio-tcy-apr.md`, `knowledge/README.md` | Durable investigation and chart contract |
| `docs/development-workflow.md` | Local chart hot-reload verification guidance |

## Publication and Handoff

Publish this session's reviewed changes to `origin/feat/thorfolio` under the
explicit end-session authorization. No production deployment, merge, wallet
transaction, or upstream Midgard change is part of this session. The dev server
remains available for continued review.
