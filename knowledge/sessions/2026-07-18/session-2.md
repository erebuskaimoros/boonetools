# Session 2 - Production Dashboard Reliability and Treasury Tracking

> Date: 2026-07-18
> Focus: Correct Rapid Swaps ordering, preserve lazy dashboard availability across deploys, and add Treasury Vultisig 2 staked TCY

## Summary

Fixed and deployed three production regressions: the Rapid Swaps table now shows the newest swaps instead of the largest swaps, stale frontend tabs retain access to lazy dashboard chunks across releases, and Treasury Vultisig 2 now includes its live TCY staking position. Production API, performance, and rendered-browser checks passed; responsive fit work for the ADR26 and App Layer dashboards remains open for the next session.

## Work Done

- Split Rapid Swaps' largest-by-volume and newest-by-date read-model rows into independent `top_20` and `latest_20` datasets.
- Corrected the first Rapid Swaps table page to use `latest_20` while preserving `top_20` for the largest-swap metric.
- Replaced one-off App Layer chunk compatibility copies with 30-day retention for all prior hashed frontend assets.
- Added guarded one-time recovery for stale dynamic imports plus a visible retry state instead of a blank dashboard.
- Added address-specific TCY staking ingestion for Treasury Vultisig 2 from `/thorchain/tcy_staker/{address}`.
- Modeled staked TCY separately from liquid balances and included it in entry, Active, consolidated, and total Treasury values.
- Added last-good fallback and segment freshness metadata for the TCY staking position.
- Deployed backend and frontend changes and verified production performance budgets.
- Verified production displays 23,300,000 staked TCY, currently valued at about $2.81 million, in both the Vultisig 2 card and consolidated view.

## Discoveries

- `top_20` is ordered by comparable USD volume and cannot also serve the newest-date table page; the two views need independent read-model collections.
- Deleting old hashed Vite chunks during deployment breaks lazy routes in already-open tabs even when every backend API is healthy.
- Retaining hashed assets for a bounded period fixes old application shells without allowing unbounded asset accumulation; guarded reload remains useful beyond the retention window.
- TCY staking is not a bank balance. Treating it as a separate position prevents liquid/staked mislabeling and future double counting.
- Treasury Vultisig 2's live staking record is 2,330,000,000,000,000 base units, or 23,300,000 TCY.

## Files Changed

| File | Change |
|------|--------|
| `backend/src/shared/rapid-swaps-dashboard.js` | Added independent newest-date `latest_20` rows. |
| `backend/src/handlers/rapid-swaps.js` | Routed the default newest table page to `latest_20`. |
| `backend/tests/analytics-read-models.test.js` | Protected largest-versus-latest row semantics. |
| `scripts/deploy-boonetools-frontend.sh` | Retained prior hashed assets for 30 days and pruned older files. |
| `src/App.svelte` | Added stale dynamic-import recovery and a retryable error state. |
| `shared/treasury/config.js` | Marked Treasury Vultisig 2 for TCY staking collection. |
| `shared/treasury/model.js` | Added staked-position normalization, aggregation, pricing, and totals. |
| `backend/src/treasury/providers.js` | Added the address-specific THORNode TCY staker provider. |
| `backend/src/treasury/builder.js` | Published schema v2 Treasury snapshots with resilient TCY stake segments. |
| `backend/src/jobs/treasury-snapshot.js` | Added staked-position publisher statistics. |
| `backend/tests/treasury-snapshot.test.js` | Covered TCY provider paths, pricing, aggregation, and last-good fallback. |
| `src/lib/Treasury.svelte` | Rendered Staked Positions and added stake values to every dashboard rollup. |

## In Progress

The ADR26 Dynamic Fees and App Layer dashboards do not fit the available viewport. Production reproduction and CSS inspection began, but no layout changes were made before the session ended.

## Next Steps

- [ ] Reproduce ADR26 and App Layer overflow at representative desktop and mobile viewport sizes.
- [ ] Correct their responsive containers, grids, tables, and chart minimum widths without reducing readability.
- [ ] Add layout regression coverage and verify both dashboards in the rendered production site.
- [ ] Monitor the Treasury stake segment and retained frontend asset pruning through normal timer/deploy cycles.
