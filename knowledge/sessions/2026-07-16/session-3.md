# Session 3 - TC Fee Native Yield Chart

> Date: 2026-07-16
> Focus: Add and deploy a native THORChain income-to-volume chart on the TC Fee Dash

## Summary

Added a second TC Fee Dash chart for liquidity-fee income divided by matching THORChain swap volume, expressed in basis points. The backend now stores Midgard native volume, backfills historical rows independently of the Dune/CMC fee path, and serves volume-weighted day/week/month and rolling ratios; migration, backfill, API, frontend, and production rendering were deployed and verified.

## Work Done

- Added `thorchain_volume_usd` through migration 024 and exposed it through the TC Fee Dash API.
- Ingested Midgard `/history/swaps` `totalVolumeUSD` alongside every new daily fee row.
- Added an isolated 400-day historical volume backfill so existing income rows did not need an expensive Dune/CMC replay.
- Added a second Chart.js panel below the existing market-normalized chart with shared date, granularity, halt, and rolling-average controls.
- Kept aggregation mathematically correct by summing income and volume before division.
- Added a truthful pending state for the short interval before historical volume backfill completes.
- Passed 106 frontend tests, 60 backend tests, the production build, browser QA, and the workspace audit.
- Deployed backend migration/API/job first, completed all 1,485 historical daily volume rows, then deployed and visually verified the frontend.

## Discoveries

- Midgard earnings `liquidityFees` is the existing TC Fee Dash income field; matching native volume is Midgard swap history `totalVolumeUSD`, which is returned in USD cents.
- A grouped income/volume metric must be calculated from summed numerators and denominators, not by averaging daily percentages.
- The backend deploy restarts the TC Fee timer; on this deployment that timer completed the historical native-volume fill before the manual verification pass.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/024_tc_fee_dash_income_volume.sql` | Added the native THORChain volume column |
| `backend/src/shared/tc-fee-dash-ingestion.js` | Added Midgard swap-volume ingestion and historical backfill |
| `backend/src/shared/tc-fee-dash.js` | Normalized and summarized native volume and yield |
| `backend/src/handlers/tc-fee-dash.js` | Returned native volume and scope metadata from the API |
| `src/lib/tc-fee-dash/model.js` | Added weighted yield, aggregation, summary, and rolling-average math |
| `src/lib/TCFeeDash.svelte` | Added the second chart and backfill-pending state |
| `tests/tc-fee-dash.test.js` | Covered frontend native-yield calculations |
| `backend/tests/tc-fee-dash.test.js` | Covered API normalization and Midgard USD-cent parsing |

## In Progress

None - session complete and deployed.

## Next Steps

- [ ] Confirm the next scheduled daily row receives native swap volume without invoking historical backfill.
- [ ] Monitor the TC Fee timer and API freshness after the next UTC boundary.
- [ ] Revisit the displayed yield label if product language should distinguish liquidity-fee income from broader system income.
